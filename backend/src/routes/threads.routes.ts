import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { ThreadMode } from "../models/items.js";
import type { ChatEvent, ChatService, SendMessageInput } from "../services/chat.service.js";
import type { CreateThreadInput, ThreadsService } from "../services/threads.service.js";
import { toMessageResponse, toThreadResponse } from "./mappers.js";

export interface ThreadsRoutesOptions {
  threadsService: ThreadsService;
  chatService: ChatService;
}

const MODES: ThreadMode[] = ["assignment_help", "exam_prep", "concept_review"];

const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 200;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_ATTACHMENTS = 5;

/** One server-sent event: the event name is the type, and the data is everything else. */
function toSse({ type, ...data }: ChatEvent): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function* toSseStream(events: AsyncIterable<ChatEvent>): AsyncGenerator<string> {
  for await (const event of events) {
    yield toSse(event);
  }
}

export async function threadsRoutes(app: FastifyInstance, opts: ThreadsRoutesOptions): Promise<void> {
  const { threadsService, chatService } = opts;

  app.post<{ Params: { courseId: string }; Body: CreateThreadInput }>(
    "/courses/:courseId/threads",
    {
      schema: {
        body: {
          type: "object",
          required: ["mode"],
          additionalProperties: false,
          properties: {
            mode: { type: "string", enum: MODES },
            title: { type: "string" },
            assignmentId: { type: "string" },
            pinnedResourceIds: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const thread = await threadsService.createThread(request.userId, request.params.courseId, request.body);
      return reply.status(201).send(toThreadResponse(thread));
    },
  );

  app.get<{ Params: { courseId: string } }>("/courses/:courseId/threads", async (request) => {
    const threads = await threadsService.listThreads(request.userId, request.params.courseId);
    return { threads: threads.map(toThreadResponse) };
  });

  app.get<{ Params: { courseId: string; threadId: string } }>(
    "/courses/:courseId/threads/:threadId",
    async (request) => {
      const thread = await threadsService.getThread(request.userId, request.params.courseId, request.params.threadId);
      return toThreadResponse(thread);
    },
  );

  app.get<{ Params: { courseId: string; threadId: string }; Querystring: { limit: number } }>(
    "/courses/:courseId/threads/:threadId/messages",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: MAX_MESSAGE_LIMIT, default: DEFAULT_MESSAGE_LIMIT },
          },
        },
      },
    },
    async (request) => {
      const messages = await threadsService.listMessages(
        request.userId,
        request.params.courseId,
        request.params.threadId,
        request.query.limit,
      );
      return { messages: messages.map(toMessageResponse) };
    },
  );

  app.post<{ Params: { courseId: string; threadId: string }; Body: SendMessageInput }>(
    "/courses/:courseId/threads/:threadId/messages",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: {
            text: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_CHARS },
            attachmentFileIds: { type: "array", items: { type: "string" }, maxItems: MAX_ATTACHMENTS },
          },
        },
      },
    },
    async (request, reply) => {
      // anything that can be refused (unknown thread, bad attachment) throws here, before the response starts
      const events = await chatService.sendMessage(
        request.userId,
        request.params.courseId,
        request.params.threadId,
        request.body,
      );
      return reply
        .type("text/event-stream")
        .header("cache-control", "no-cache")
        .send(Readable.from(toSseStream(events)));
    },
  );
}
