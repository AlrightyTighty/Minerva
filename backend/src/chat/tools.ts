import type { ToolSpec } from "../clients/chat-model.js";
import type { CourseSearch } from "../clients/course-search.js";
import type { ObjectStore } from "../clients/object-store.js";
import type { ActiveResource, CourseFile, FileRef } from "../models/items.js";
import type { FilesRepository } from "../repositories/files.repository.js";
import type { ThreadRef, ThreadsRepository } from "../repositories/threads.repository.js";

/** How many turns a loaded resource stays in front of the model after it was last used. */
export const ACTIVE_RESOURCE_TURNS = 5;

/** At most this many resources stay loaded at once. */
export const MAX_ACTIVE_RESOURCES = 3;

const SEARCH_RESULT_COUNT = 6;

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "search_course_materials",
    description:
      "Search the student's course materials for passages relevant to a query. Works on every material, " +
      "including search-only ones such as textbooks. Optionally narrow the search to one material or one type.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, phrased as a search query." },
        resource_id: { type: "string", description: "Only search inside this material (its id from the list)." },
        doc_type: {
          type: "string",
          enum: ["assignment", "syllabus", "textbook", "notes"],
          description: "Only search materials of this type.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_resource",
    description:
      "Read the full text of one material that is marked as readable. Search-only materials and images cannot be read this way.",
    inputSchema: {
      type: "object",
      properties: { resource_id: { type: "string", description: "The material's id from the list." } },
      required: ["resource_id"],
    },
  },
  {
    name: "load_resource",
    description:
      "Like get_resource, and also keeps the material in front of you for the next few turns. " +
      "Use it when the student will keep working from that material.",
    inputSchema: {
      type: "object",
      properties: { resource_id: { type: "string", description: "The material's id from the list." } },
      required: ["resource_id"],
    },
  },
];

/** Everything a tool may know about who is asking. It comes from the session, never from the model. */
export interface ToolContext {
  userId: string;
  courseId: string;
  threadId: string;
  /** The turn being answered. */
  turn: number;
  activeResources: Record<string, ActiveResource>;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  /** What the model sees. */
  text: string;
  /** One line that is stored in the thread in place of `text`. */
  summary: string;
  isError?: boolean;
  resourceId?: string;
}

export interface CourseToolsDeps {
  files: Pick<FilesRepository, "get">;
  search: CourseSearch;
  objects: Pick<ObjectStore, "getText">;
  threads: Pick<ThreadsRepository, "setActiveResource" | "removeActiveResources">;
  processedBucket: string;
}

const failure = (text: string, summary = text): ToolResult => ({ text, summary, isError: true });

const stringInput = (input: Record<string, unknown>, key: string): string | undefined => {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

export class CourseTools {
  constructor(private readonly deps: CourseToolsDeps) {}

  /** Runs a tool. Problems the model can recover from are returned as error results, never thrown. */
  async execute(context: ToolContext, call: ToolCall): Promise<ToolResult> {
    try {
      switch (call.name) {
        case "search_course_materials":
          return await this.search(context, call.input);
        case "get_resource":
          return await this.read(context, call.input, false);
        case "load_resource":
          return await this.read(context, call.input, true);
        default:
          return failure(`There is no tool named "${call.name}".`, `Unknown tool ${call.name}`);
      }
    } catch {
      return failure("The tool failed. Try again, or answer without it.", `${call.name} failed`);
    }
  }

  /** The line shown to the student while a tool runs. */
  async describe(context: ToolContext, call: ToolCall): Promise<string> {
    if (call.name === "search_course_materials") {
      const query = stringInput(call.input, "query");
      return query ? `Searching course materials for "${query}"…` : "Searching course materials…";
    }
    if (call.name === "get_resource" || call.name === "load_resource") {
      const resourceId = stringInput(call.input, "resource_id");
      try {
        const file = resourceId ? await this.deps.files.get(this.ref(context, resourceId)) : undefined;
        if (file) return `Reading ${file.title}…`;
      } catch {
        // fall through to the generic message
      }
      return "Reading course material…";
    }
    return "Working…";
  }

  private async search(context: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
    const query = stringInput(input, "query");
    if (!query) {
      return failure("A query is required.");
    }
    const fileId = stringInput(input, "resource_id");
    const docType = stringInput(input, "doc_type");

    // the user and course come from the session. The model can only narrow the search with the other two.
    const hits = await this.deps.search.retrieve({
      query,
      filter: {
        userId: context.userId,
        courseId: context.courseId,
        ...(fileId ? { fileId } : {}),
        ...(docType ? { docType } : {}),
      },
      topK: SEARCH_RESULT_COUNT,
    });
    if (hits.length === 0) {
      return { text: "No results found for that query.", summary: `Searched for "${query}": no results` };
    }

    const titles = new Map<string, string>();
    for (const id of new Set(hits.flatMap((hit) => (hit.fileId ? [hit.fileId] : [])))) {
      const file = await this.deps.files.get(this.ref(context, id));
      titles.set(id, file?.title ?? id);
    }
    const passages = hits.map((hit) =>
      hit.fileId ? `[${titles.get(hit.fileId)} (${hit.fileId})]\n${hit.text}` : hit.text,
    );
    return {
      text: passages.join("\n\n---\n\n"),
      summary: `Searched for "${query}": ${hits.length} result${hits.length === 1 ? "" : "s"}`,
    };
  }

  private async read(context: ToolContext, input: Record<string, unknown>, keepLoaded: boolean): Promise<ToolResult> {
    const resourceId = stringInput(input, "resource_id");
    if (!resourceId) {
      return failure("A resource_id is required.");
    }

    // looked up under the session's user and course, so another user's or course's file is simply not found
    const file = await this.deps.files.get(this.ref(context, resourceId));
    const refusal = this.refusal(file, resourceId);
    if (refusal || !file) {
      return refusal ?? failure(`File "${resourceId}" not found.`);
    }

    const markdown = await this.deps.objects.getText(this.deps.processedBucket, file.markdownKey as string);
    if (keepLoaded) {
      await this.keepLoaded(context, resourceId);
    }
    return {
      text: `# ${file.title} (${file.fileId})\n\n${markdown}`,
      summary: `${keepLoaded ? "Loaded" : "Read"} "${file.title}"`,
      resourceId: file.fileId,
    };
  }

  private refusal(file: CourseFile | undefined, resourceId: string): ToolResult | undefined {
    if (!file || file.deletedAt) {
      return failure(`File "${resourceId}" not found.`, `Could not read ${resourceId}`);
    }
    if (file.status !== "ready") {
      return failure(`File "${resourceId}" is not ready yet (${file.status}).`, `Could not read ${resourceId}`);
    }
    if (file.docType === "image") {
      return failure(
        `"${file.title}" is an image. Images can only be seen when attached to a message.`,
        `Could not read ${resourceId}`,
      );
    }
    if (file.searchOnly || !file.markdownKey) {
      return failure(
        `"${file.title}" is too large to read in full. Use search_course_materials with resource_id "${resourceId}" instead.`,
        `Could not read ${resourceId}`,
      );
    }
    return undefined;
  }

  /** Keeps the file loaded for the next few turns, and drops expired entries and whatever the cap pushes out. */
  private async keepLoaded(context: ToolContext, fileId: string): Promise<void> {
    const { threads } = this.deps;
    const threadRef: ThreadRef = { userId: context.userId, courseId: context.courseId, threadId: context.threadId };

    const existing = context.activeResources[fileId];
    const stillActive = existing !== undefined && existing.expiresAfterTurn >= context.turn;
    await threads.setActiveResource(threadRef, fileId, {
      loadedAtTurn: stillActive ? existing.loadedAtTurn : context.turn,
      expiresAfterTurn: context.turn + ACTIVE_RESOURCE_TURNS,
    });

    const others = Object.entries(context.activeResources).filter(([id]) => id !== fileId);
    const expired = others.filter(([, resource]) => resource.expiresAfterTurn < context.turn).map(([id]) => id);
    const live = others
      .filter(([, resource]) => resource.expiresAfterTurn >= context.turn)
      .sort(([, a], [, b]) => a.expiresAfterTurn - b.expiresAfterTurn);
    const overflow = Math.max(0, live.length + 1 - MAX_ACTIVE_RESOURCES);
    const evicted = live.slice(0, overflow).map(([id]) => id);

    const toRemove = [...expired, ...evicted];
    if (toRemove.length > 0) {
      await threads.removeActiveResources(threadRef, toRemove);
    }
  }

  private ref(context: ToolContext, fileId: string): FileRef {
    return { userId: context.userId, courseId: context.courseId, fileId };
  }
}
