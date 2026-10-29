import type { Message, Thread, ThreadMode } from "../models/items.js";
import type { FilesRepository } from "../repositories/files.repository.js";
import type { MessagesRepository } from "../repositories/messages.repository.js";
import type { ThreadsRepository } from "../repositories/threads.repository.js";
import type { AssignmentsService } from "./assignments.service.js";
import type { CoursesService } from "./courses.service.js";

export class ThreadNotFoundError extends Error {
  constructor(threadId: string) {
    super(`Thread "${threadId}" not found`);
  }
}

export class InvalidThreadError extends Error {}

export interface CreateThreadInput {
  mode: ThreadMode;
  title?: string;
  assignmentId?: string;
  pinnedResourceIds?: string[];
}

export interface ThreadsServiceDeps {
  threads: ThreadsRepository;
  messages: MessagesRepository;
  files: FilesRepository;
  courses: CoursesService;
  assignments: Pick<AssignmentsService, "getAssignment">;
  newId: () => string;
  now: () => Date;
}

const DEFAULT_TITLE = "New chat";

export class ThreadsService {
  constructor(private readonly deps: ThreadsServiceDeps) {}

  async createThread(userId: string, courseId: string, input: CreateThreadInput): Promise<Thread> {
    const { threads, files, courses, assignments, newId, now } = this.deps;

    await courses.getCourse(userId, courseId);

    // a thread about an assignment starts with that assignment's files pinned. Files that have since been deleted
    // are left out quietly, since the student did not name them.
    const assignmentFileIds: string[] = [];
    if (input.assignmentId) {
      const assignment = await assignments.getAssignment(userId, courseId, input.assignmentId);
      for (const fileId of assignment.fileIds ?? []) {
        const file = await files.get({ userId, courseId, fileId });
        if (file && !file.deletedAt) {
          assignmentFileIds.push(fileId);
        }
      }
    }

    const explicitIds = [...new Set(input.pinnedResourceIds ?? [])];
    for (const fileId of explicitIds) {
      if (assignmentFileIds.includes(fileId)) continue;
      const file = await files.get({ userId, courseId, fileId });
      if (!file || file.deletedAt) {
        throw new InvalidThreadError(`Pinned file "${fileId}" not found`);
      }
    }
    const pinnedResourceIds = [...new Set([...assignmentFileIds, ...explicitIds])];

    const timestamp = now().toISOString();
    const thread: Thread = {
      threadId: newId(),
      courseId,
      userId,
      title: input.title?.trim() || DEFAULT_TITLE,
      mode: input.mode,
      ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
      turnCount: 0,
      pinnedResourceIds,
      activeResources: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (!(await threads.create(thread))) {
      throw new Error(`Thread id collision for ${thread.threadId}`);
    }
    return thread;
  }

  /** The course's threads that are not deleted, most recently active first. */
  async listThreads(userId: string, courseId: string): Promise<Thread[]> {
    await this.deps.courses.getCourse(userId, courseId);
    const threads = await this.deps.threads.listByCourse(userId, courseId);
    return threads
      .filter((thread) => !thread.deletedAt)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  /** Threads are keyed by user, so another user's thread is simply not found. */
  async getThread(userId: string, courseId: string, threadId: string): Promise<Thread> {
    const thread = await this.deps.threads.get({ userId, courseId, threadId });
    if (!thread || thread.deletedAt) {
      throw new ThreadNotFoundError(threadId);
    }
    return thread;
  }

  /** Checks the user owns the thread before reading its messages, which are keyed by thread alone. */
  async listMessages(userId: string, courseId: string, threadId: string, limit: number): Promise<Message[]> {
    await this.getThread(userId, courseId, threadId);
    return this.deps.messages.listRecent(threadId, limit);
  }
}
