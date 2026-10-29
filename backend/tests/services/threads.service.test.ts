import { describe, expect, it, vi } from "vitest";
import type { CourseFile, Message, Thread } from "../../src/models/items.js";
import { AssignmentNotFoundError } from "../../src/services/assignments.service.js";
import { CourseNotFoundError } from "../../src/services/courses.service.js";
import { InvalidThreadError, ThreadNotFoundError, ThreadsService } from "../../src/services/threads.service.js";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ref = { userId: "u1", courseId: "c1", threadId: "t1" };

const thread = (overrides: Partial<Thread> = {}): Thread => ({
  threadId: "t1",
  courseId: "c1",
  userId: "u1",
  title: "New chat",
  mode: "concept_review",
  turnCount: 0,
  pinnedResourceIds: [],
  activeResources: {},
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const file = (fileId: string, overrides: Partial<CourseFile> = {}) =>
  ({ fileId, userId: "u1", courseId: "c1", status: "ready", ...overrides }) as CourseFile;

function build() {
  const threads = { create: vi.fn().mockResolvedValue(true), get: vi.fn(), listByCourse: vi.fn() };
  const messages = { listRecent: vi.fn().mockResolvedValue([]) };
  const files = { get: vi.fn() };
  const courses = { getCourse: vi.fn().mockResolvedValue({ courseId: "c1", userId: "u1" }) };
  const assignments = { getAssignment: vi.fn().mockResolvedValue({ assignmentId: "a1", courseId: "c1", fileIds: [] }) };
  const service = new ThreadsService({
    threads,
    messages,
    files,
    courses,
    assignments,
    newId: () => "t-new",
    now: () => NOW,
  } as never);
  return { service, threads, messages, files, courses, assignments };
}

describe("ThreadsService.createThread", () => {
  it("creates an empty thread in the course, owned by the user", async () => {
    const { service, threads } = build();

    const created = await service.createThread("u1", "c1", { mode: "exam_prep" });

    expect(created).toEqual({
      threadId: "t-new",
      courseId: "c1",
      userId: "u1",
      title: "New chat",
      mode: "exam_prep",
      turnCount: 0,
      pinnedResourceIds: [],
      activeResources: {},
      createdAt: "2026-10-26T12:00:00.000Z",
      updatedAt: "2026-10-26T12:00:00.000Z",
    });
    expect(threads.create).toHaveBeenCalledWith(created);
  });

  it("uses the given title, trimmed, and the assignment it is for", async () => {
    const { service } = build();

    const created = await service.createThread("u1", "c1", {
      mode: "assignment_help",
      title: "  Lab 2  ",
      assignmentId: "a1",
    });

    expect(created.title).toBe("Lab 2");
    expect(created.assignmentId).toBe("a1");
  });

  it("checks the course belongs to the user, and creates nothing if it does not", async () => {
    const { service, courses, threads } = build();
    courses.getCourse.mockRejectedValue(new CourseNotFoundError("c9"));

    await expect(service.createThread("u1", "c9", { mode: "exam_prep" })).rejects.toThrow(CourseNotFoundError);

    expect(courses.getCourse).toHaveBeenCalledWith("u1", "c9");
    expect(threads.create).not.toHaveBeenCalled();
  });

  it("pins files from the course", async () => {
    const { service, files } = build();
    files.get.mockImplementation(async ({ fileId }: { fileId: string }) => file(fileId));

    const created = await service.createThread("u1", "c1", { mode: "exam_prep", pinnedResourceIds: ["f1", "f2"] });

    expect(created.pinnedResourceIds).toEqual(["f1", "f2"]);
    expect(files.get).toHaveBeenCalledWith({ userId: "u1", courseId: "c1", fileId: "f1" });
  });

  it.each([
    ["does not exist in the course", undefined],
    ["is soft-deleted", file("f1", { deletedAt: "2026-10-20T00:00:00.000Z" })],
  ])("refuses to pin a file that %s", async (_label, stored) => {
    const { service, files, threads } = build();
    files.get.mockResolvedValue(stored);

    await expect(
      service.createThread("u1", "c1", { mode: "exam_prep", pinnedResourceIds: ["f1"] }),
    ).rejects.toThrow(InvalidThreadError);

    expect(threads.create).not.toHaveBeenCalled();
  });

  it("pins each file only once", async () => {
    const { service, files } = build();
    files.get.mockImplementation(async ({ fileId }: { fileId: string }) => file(fileId));

    const created = await service.createThread("u1", "c1", { mode: "exam_prep", pinnedResourceIds: ["f1", "f1"] });

    expect(created.pinnedResourceIds).toEqual(["f1"]);
  });
});

describe("ThreadsService.createThread for an assignment", () => {
  const withFiles = (...fileIds: string[]) => ({ assignmentId: "a1", courseId: "c1", fileIds });

  it("pins the assignment's files automatically", async () => {
    const { service, assignments, files } = build();
    assignments.getAssignment.mockResolvedValue(withFiles("f1", "f2"));
    files.get.mockImplementation(async ({ fileId }: { fileId: string }) => file(fileId));

    const created = await service.createThread("u1", "c1", { mode: "assignment_help", assignmentId: "a1" });

    expect(assignments.getAssignment).toHaveBeenCalledWith("u1", "c1", "a1");
    expect(created.assignmentId).toBe("a1");
    expect(created.pinnedResourceIds).toEqual(["f1", "f2"]);
  });

  it("adds files pinned explicitly after the assignment's, with no duplicates", async () => {
    const { service, assignments, files } = build();
    assignments.getAssignment.mockResolvedValue(withFiles("f1", "f2"));
    files.get.mockImplementation(async ({ fileId }: { fileId: string }) => file(fileId));

    const created = await service.createThread("u1", "c1", {
      mode: "assignment_help",
      assignmentId: "a1",
      pinnedResourceIds: ["f2", "f3"],
    });

    expect(created.pinnedResourceIds).toEqual(["f1", "f2", "f3"]);
  });

  it("leaves out assignment files that have since been deleted, instead of refusing the thread", async () => {
    const { service, assignments, files } = build();
    assignments.getAssignment.mockResolvedValue(withFiles("f1", "f2", "f3"));
    files.get.mockImplementation(async ({ fileId }: { fileId: string }) => {
      if (fileId === "f2") return file("f2", { deletedAt: "2026-10-20T00:00:00.000Z" });
      if (fileId === "f3") return undefined;
      return file(fileId);
    });

    const created = await service.createThread("u1", "c1", { mode: "assignment_help", assignmentId: "a1" });

    expect(created.pinnedResourceIds).toEqual(["f1"]);
  });

  it("still refuses an explicitly pinned file that does not exist", async () => {
    const { service, assignments, files, threads } = build();
    assignments.getAssignment.mockResolvedValue(withFiles("f1"));
    files.get.mockImplementation(async ({ fileId }: { fileId: string }) => (fileId === "f1" ? file("f1") : undefined));

    await expect(
      service.createThread("u1", "c1", { mode: "assignment_help", assignmentId: "a1", pinnedResourceIds: ["f9"] }),
    ).rejects.toThrow(InvalidThreadError);

    expect(threads.create).not.toHaveBeenCalled();
  });

  it("works for an assignment with no files", async () => {
    const { service } = build();

    const created = await service.createThread("u1", "c1", { mode: "assignment_help", assignmentId: "a1" });

    expect(created.pinnedResourceIds).toEqual([]);
  });

  it("refuses an assignment that does not exist, and creates nothing", async () => {
    const { service, assignments, threads } = build();
    assignments.getAssignment.mockRejectedValue(new AssignmentNotFoundError("a9"));

    await expect(
      service.createThread("u1", "c1", { mode: "assignment_help", assignmentId: "a9" }),
    ).rejects.toThrow(AssignmentNotFoundError);

    expect(threads.create).not.toHaveBeenCalled();
  });

  it("does not look up an assignment when the thread is not about one", async () => {
    const { service, assignments } = build();

    await service.createThread("u1", "c1", { mode: "exam_prep" });

    expect(assignments.getAssignment).not.toHaveBeenCalled();
  });

  it("takes the assignment's files as they are when the thread is created, not later", async () => {
    // pinned ids are copied onto the thread, so files added to the assignment afterwards are not pinned to it
    const { service, assignments, files } = build();
    assignments.getAssignment.mockResolvedValue(withFiles("f1"));
    files.get.mockImplementation(async ({ fileId }: { fileId: string }) => file(fileId));

    const created = await service.createThread("u1", "c1", { mode: "assignment_help", assignmentId: "a1" });
    assignments.getAssignment.mockResolvedValue(withFiles("f1", "f2"));

    expect(created.pinnedResourceIds).toEqual(["f1"]);
  });
});

describe("ThreadsService.listThreads", () => {
  it("lists the course's threads that are not deleted, newest first, after checking the course", async () => {
    const { service, threads, courses } = build();
    threads.listByCourse.mockResolvedValue([
      thread({ threadId: "t1", updatedAt: "2026-10-01T00:00:00.000Z" }),
      thread({ threadId: "t2", deletedAt: "2026-10-02T00:00:00.000Z" }),
      thread({ threadId: "t3", updatedAt: "2026-10-03T00:00:00.000Z" }),
    ]);

    const result = await service.listThreads("u1", "c1");

    expect(courses.getCourse).toHaveBeenCalledWith("u1", "c1");
    expect(threads.listByCourse).toHaveBeenCalledWith("u1", "c1");
    expect(result.map((t) => t.threadId)).toEqual(["t3", "t1"]);
  });

  it("throws CourseNotFoundError for a course the user does not have", async () => {
    const { service, courses } = build();
    courses.getCourse.mockRejectedValue(new CourseNotFoundError("c9"));

    await expect(service.listThreads("u1", "c9")).rejects.toThrow(CourseNotFoundError);
  });
});

describe("ThreadsService.getThread", () => {
  it("returns the thread", async () => {
    const { service, threads } = build();
    threads.get.mockResolvedValue(thread());

    await expect(service.getThread("u1", "c1", "t1")).resolves.toEqual(thread());
    expect(threads.get).toHaveBeenCalledWith(ref);
  });

  it("throws ThreadNotFoundError for a missing thread, which also covers another user's thread", async () => {
    const { service, threads } = build();
    threads.get.mockResolvedValue(undefined);

    await expect(service.getThread("u1", "c1", "t9")).rejects.toThrow(ThreadNotFoundError);
  });

  it("treats a soft-deleted thread as not found", async () => {
    const { service, threads } = build();
    threads.get.mockResolvedValue(thread({ deletedAt: "2026-10-02T00:00:00.000Z" }));

    await expect(service.getThread("u1", "c1", "t1")).rejects.toThrow(ThreadNotFoundError);
  });
});

describe("ThreadsService.listMessages", () => {
  const message = (messageId: string): Message => ({
    messageId,
    role: "user",
    turn: 1,
    contentBlocks: [],
    hydratedResourceIds: [],
  });

  it("returns the thread's recent messages after checking the user owns the thread", async () => {
    const { service, threads, messages } = build();
    threads.get.mockResolvedValue(thread());
    messages.listRecent.mockResolvedValue([message("m1"), message("m2")]);

    const result = await service.listMessages("u1", "c1", "t1", 25);

    expect(threads.get).toHaveBeenCalledWith(ref);
    expect(messages.listRecent).toHaveBeenCalledWith("t1", 25);
    expect(result.map((m) => m.messageId)).toEqual(["m1", "m2"]);
  });

  it("never reads messages for a thread the user does not own", async () => {
    const { service, threads, messages } = build();
    threads.get.mockResolvedValue(undefined);

    await expect(service.listMessages("u1", "c1", "t9", 25)).rejects.toThrow(ThreadNotFoundError);

    expect(messages.listRecent).not.toHaveBeenCalled();
  });
});
