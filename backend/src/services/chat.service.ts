import { planHydration } from "../chat/hydration.js";
import { buildPrompt } from "../chat/prompt.js";
import { TOOL_SPECS, type CourseTools, type ToolContext } from "../chat/tools.js";
import type { ChatModel, ModelContentBlock, ModelEvent } from "../clients/chat-model.js";
import type { ObjectStore } from "../clients/object-store.js";
import type { ContentBlock, CourseFile, Message, Thread } from "../models/items.js";
import type { FilesRepository } from "../repositories/files.repository.js";
import type { MessagesRepository } from "../repositories/messages.repository.js";
import type { ThreadsRepository } from "../repositories/threads.repository.js";
import { AssignmentNotFoundError, type AssignmentsService } from "./assignments.service.js";
import { ThreadNotFoundError } from "./threads.service.js";
import type { UsersService } from "./users.service.js";

/** How many of the thread's latest messages are loaded for context. */
export const HISTORY_MESSAGE_LIMIT = 40;

/** After this many rounds of tool calls the model is asked to answer without tools. */
export const MAX_TOOL_ROUNDS = 5;

const FAILURE_MESSAGE = "The assistant could not respond. Please try again.";

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool_status"; message: string }
  | { type: "done"; messageId: string; turn: number }
  | { type: "error"; message: string };

/** The message cannot be sent as it is, for example an attachment that is not available. */
export class InvalidMessageError extends Error {}

export interface ChatServiceDeps {
  threads: ThreadsRepository;
  messages: MessagesRepository;
  files: FilesRepository;
  assignments: Pick<AssignmentsService, "getAssignment">;
  users: Pick<UsersService, "getUser">;
  objects: ObjectStore;
  tools: Pick<CourseTools, "execute" | "describe">;
  model: ChatModel;
  rawBucket: string;
  processedBucket: string;
  newId: () => string;
  now: () => Date;
}

export interface SendMessageInput {
  text: string;
  attachmentFileIds?: string[];
}

interface Turn {
  thread: Thread;
  turn: number;
  system: string;
  messages: ReturnType<typeof buildPrompt>["messages"];
}

export class ChatService {
  constructor(private readonly deps: ChatServiceDeps) {}

  /**
   * Checks the request, stores the user's message and returns the reply as a stream of events.
   * Everything that can be refused is refused here, before anything streams, so it can be a normal HTTP error.
   * Once the stream starts, a failure is reported as an "error" event instead.
   */
  async sendMessage(
    userId: string,
    courseId: string,
    threadId: string,
    input: SendMessageInput,
  ): Promise<AsyncIterable<ChatEvent>> {
    const { threads, messages, files, objects, newId } = this.deps;

    const thread = await threads.get({ userId, courseId, threadId });
    if (!thread || thread.deletedAt) {
      throw new ThreadNotFoundError(threadId);
    }
    const [catalog, history, assignment, profile] = await Promise.all([
      files.listByCourse(userId, courseId),
      messages.listRecent(threadId, HISTORY_MESSAGE_LIMIT),
      this.loadAssignment(thread),
      // read every turn, so a change to the student's study preferences reaches a conversation that is already running
      this.deps.users.getUser(userId),
    ]);

    const attachmentIds = [...new Set(input.attachmentFileIds ?? [])];
    const usable = new Map(
      catalog.filter((file) => file.status === "ready" && !file.deletedAt).map((file) => [file.fileId, file]),
    );
    for (const fileId of attachmentIds) {
      if (!usable.has(fileId)) {
        throw new InvalidMessageError(`Attachment "${fileId}" is not available`);
      }
    }

    const turn = thread.turnCount + 1;
    const plan = planHydration({ files: catalog, attachmentIds, thread, turn });
    const [documents, images] = await Promise.all([
      Promise.all(
        plan.documents.map(async (file) => ({
          file,
          markdown: await objects.getText(this.deps.processedBucket, file.markdownKey as string),
        })),
      ),
      Promise.all(
        plan.images.map(async (file) => ({
          file,
          bytes: await objects.getBytes(this.deps.rawBucket, file.rawKey),
        })),
      ),
    ]);

    const prompt = buildPrompt({
      mode: thread.mode,
      studyPreferences: profile.studyPreferences,
      assignment,
      catalog,
      documents,
      images,
      history,
      text: input.text,
    });

    const userMessage: Message = {
      messageId: newId(),
      role: "user",
      turn,
      contentBlocks: [
        { type: "text", text: input.text },
        ...attachmentIds.map((resourceId): ContentBlock => ({ type: "resourceRef", resourceId })),
      ],
      hydratedResourceIds: [...plan.documents, ...plan.images].map((file: CourseFile) => file.fileId),
    };
    if (!(await messages.put(threadId, userMessage))) {
      throw new Error(`Message id collision for ${userMessage.messageId}`);
    }

    return this.reply({ thread, turn, system: prompt.system, messages: prompt.messages });
  }

  /** The assignment a thread is about, read fresh each turn so edits show up. A gone or deleted one is just left out. */
  private async loadAssignment(thread: Thread) {
    if (!thread.assignmentId) {
      return undefined;
    }
    try {
      return await this.deps.assignments.getAssignment(thread.userId, thread.courseId, thread.assignmentId);
    } catch (err) {
      if (err instanceof AssignmentNotFoundError) {
        return undefined;
      }
      throw err;
    }
  }

  private async *reply(state: Turn): AsyncGenerator<ChatEvent> {
    const { threads, messages, model, tools, newId } = this.deps;
    const { thread, turn, system } = state;
    const conversation = [...state.messages];
    const stored: ContentBlock[] = [];
    const context: ToolContext = {
      userId: thread.userId,
      courseId: thread.courseId,
      threadId: thread.threadId,
      turn,
      activeResources: thread.activeResources,
    };

    try {
      for (let round = 0; ; round++) {
        const toolsAllowed = round < MAX_TOOL_ROUNDS;
        let text = "";
        const toolUses: Extract<ModelEvent, { type: "tool_use" }>[] = [];

        for await (const event of model.converse({ system, messages: conversation, tools: toolsAllowed ? TOOL_SPECS : [] })) {
          if (event.type === "text") {
            text += event.text;
            yield { type: "text", text: event.text };
          } else if (event.type === "tool_use") {
            toolUses.push(event);
          }
        }

        if (text) {
          stored.push({ type: "text", text });
        }
        if (toolUses.length === 0 || !toolsAllowed) {
          break;
        }

        const asked: ModelContentBlock[] = text ? [{ type: "text", text }] : [];
        const answers: ModelContentBlock[] = [];
        for (const use of toolUses) {
          asked.push({ type: "tool_use", toolUseId: use.toolUseId, name: use.name, input: use.input });
          stored.push({ type: "toolCall", toolUseId: use.toolUseId, name: use.name, input: use.input });
        }
        conversation.push({ role: "assistant", content: asked });

        for (const use of toolUses) {
          const call = { name: use.name, input: use.input };
          yield { type: "tool_status", message: await tools.describe(context, call) };
          const result = await tools.execute(context, call);

          // only a one-line reference is stored, the content is only needed by this request
          stored.push({
            type: "toolResultRef",
            toolUseId: use.toolUseId,
            ...(result.resourceId ? { resourceId: result.resourceId } : {}),
            summary: result.summary,
          });
          answers.push({ type: "tool_result", toolUseId: use.toolUseId, text: result.text, isError: result.isError ?? false });
        }
        conversation.push({ role: "user", content: answers });
      }

      const reply: Message = {
        messageId: newId(),
        role: "assistant",
        turn,
        contentBlocks: stored,
        hydratedResourceIds: [],
      };
      if (!(await messages.put(thread.threadId, reply))) {
        throw new Error(`Message id collision for ${reply.messageId}`);
      }
      // counted only once the reply is stored, so a failed reply does not use up a turn
      await threads.incrementTurn({ userId: thread.userId, courseId: thread.courseId, threadId: thread.threadId });
      yield { type: "done", messageId: reply.messageId, turn };
    } catch (err) {
      console.error(JSON.stringify({ job: "chat", threadId: thread.threadId, error: err instanceof Error ? err.message : String(err) }));
      yield { type: "error", message: FAILURE_MESSAGE };
    }
  }
}
