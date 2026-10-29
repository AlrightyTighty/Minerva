import { describe, expect, it } from "vitest";
import type { Message, Thread } from "../../src/models/items.js";
import { AssignmentNotFoundError } from "../../src/services/assignments.service.js";
import type { ChatEvent } from "../../src/services/chat.service.js";
import { CourseNotFoundError } from "../../src/services/courses.service.js";
import { InvalidMessageError } from "../../src/services/chat.service.js";
import { InvalidThreadError, ThreadNotFoundError } from "../../src/services/threads.service.js";
import { AUTH, buildTestApp } from "../support/test-app.js";

// every internal field is set, so the tests prove none of them reach the client
const thread: Thread = {
  threadId: "t1",
  courseId: "c1",
  userId: "u1",
  title: "Lab 2",
  mode: "assignment_help",
  assignmentId: "a1",
  turnCount: 4,
  pinnedResourceIds: ["f1"],
  activeResources: { f2: { loadedAtTurn: 2, expiresAfterTurn: 7 } },
  summary: "internal summary",
  summaryThrough: 3,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:05:00.000Z",
};

const threadResponse = {
  threadId: "t1",
  courseId: "c1",
  title: "Lab 2",
  mode: "assignment_help",
  assignmentId: "a1",
  turnCount: 4,
  pinnedResourceIds: ["f1"],
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:05:00.000Z",
};

describe("POST /courses/:courseId/threads", () => {
  it("creates a thread for the caller in the course", async () => {
    const { app, services } = buildTestApp();
    services.threads.createThread.mockResolvedValue(thread);

    const response = await app.inject({
      method: "POST",
      url: "/courses/c1/threads",
      headers: AUTH,
      payload: { mode: "assignment_help", title: "Lab 2", assignmentId: "a1", pinnedResourceIds: ["f1"] },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(threadResponse);
    expect(services.threads.createThread).toHaveBeenCalledWith("u1", "c1", {
      mode: "assignment_help",
      title: "Lab 2",
      assignmentId: "a1",
      pinnedResourceIds: ["f1"],
    });
  });

  it("needs only a mode", async () => {
    const { app, services } = buildTestApp();
    services.threads.createThread.mockResolvedValue(thread);

    const response = await app.inject({
      method: "POST",
      url: "/courses/c1/threads",
      headers: AUTH,
      payload: { mode: "exam_prep" },
    });

    expect(response.statusCode).toBe(201);
    expect(services.threads.createThread).toHaveBeenCalledWith("u1", "c1", { mode: "exam_prep" });
  });

  it.each([
    ["a missing mode", {}],
    ["an unknown mode", { mode: "free_chat" }],
    ["pinned ids that are not a list", { mode: "exam_prep", pinnedResourceIds: "f1" }],
  ])("rejects %s with 400", async (_label, payload) => {
    const { app, services } = buildTestApp();

    const response = await app.inject({ method: "POST", url: "/courses/c1/threads", headers: AUTH, payload });

    expect(response.statusCode).toBe(400);
    expect(services.threads.createThread).not.toHaveBeenCalled();
  });

  it("returns 404 when the course does not exist or is not the caller's", async () => {
    const { app, services } = buildTestApp();
    services.threads.createThread.mockRejectedValue(new CourseNotFoundError("c9"));

    const response = await app.inject({
      method: "POST",
      url: "/courses/c9/threads",
      headers: AUTH,
      payload: { mode: "exam_prep" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 when the assignment the thread is about does not exist", async () => {
    const { app, services } = buildTestApp();
    services.threads.createThread.mockRejectedValue(new AssignmentNotFoundError("a9"));

    const response = await app.inject({
      method: "POST",
      url: "/courses/c1/threads",
      headers: AUTH,
      payload: { mode: "assignment_help", assignmentId: "a9" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ message: 'Assignment "a9" not found' });
  });

  it("returns 400 with the reason when a pinned file is not usable", async () => {
    const { app, services } = buildTestApp();
    services.threads.createThread.mockRejectedValue(new InvalidThreadError('Pinned file "f9" not found'));

    const response = await app.inject({
      method: "POST",
      url: "/courses/c1/threads",
      headers: AUTH,
      payload: { mode: "exam_prep", pinnedResourceIds: ["f9"] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: 'Pinned file "f9" not found' });
  });
});

describe("GET /courses/:courseId/threads", () => {
  it("lists the course's threads without internal fields", async () => {
    const { app, services } = buildTestApp();
    services.threads.listThreads.mockResolvedValue([thread]);

    const response = await app.inject({ method: "GET", url: "/courses/c1/threads", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ threads: [threadResponse] });
    expect(services.threads.listThreads).toHaveBeenCalledWith("u1", "c1");
  });

  it("returns 404 for an unknown course", async () => {
    const { app, services } = buildTestApp();
    services.threads.listThreads.mockRejectedValue(new CourseNotFoundError("c9"));

    const response = await app.inject({ method: "GET", url: "/courses/c9/threads", headers: AUTH });

    expect(response.statusCode).toBe(404);
  });
});

describe("GET /courses/:courseId/threads/:threadId", () => {
  it("returns the thread without internal fields", async () => {
    const { app, services } = buildTestApp();
    services.threads.getThread.mockResolvedValue(thread);

    const response = await app.inject({ method: "GET", url: "/courses/c1/threads/t1", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(threadResponse);
    expect(services.threads.getThread).toHaveBeenCalledWith("u1", "c1", "t1");
  });

  it("returns 404 for a missing thread", async () => {
    const { app, services } = buildTestApp();
    services.threads.getThread.mockRejectedValue(new ThreadNotFoundError("t9"));

    const response = await app.inject({ method: "GET", url: "/courses/c1/threads/t9", headers: AUTH });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ message: 'Thread "t9" not found' });
  });
});

describe("GET /courses/:courseId/threads/:threadId/messages", () => {
  const messages: Message[] = [
    {
      messageId: "m1",
      role: "user",
      turn: 1,
      contentBlocks: [
        { type: "text", text: "look at this" },
        { type: "resourceRef", resourceId: "f1" },
      ],
      hydratedResourceIds: ["f1"],
      ttl: 1793000000,
    },
    {
      messageId: "m2",
      role: "assistant",
      turn: 1,
      contentBlocks: [
        { type: "toolCall", toolUseId: "tu1", name: "get_resource", input: { resource_id: "f1" } },
        { type: "toolResultRef", toolUseId: "tu1", resourceId: "f1", summary: 'Read "Lab 2"' },
        { type: "text", text: "Here you go." },
      ],
      hydratedResourceIds: [],
    },
  ];

  it("returns the messages, showing only the text and attachments, not tool plumbing or debug fields", async () => {
    const { app, services } = buildTestApp();
    services.threads.listMessages.mockResolvedValue(messages);

    const response = await app.inject({ method: "GET", url: "/courses/c1/threads/t1/messages", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      messages: [
        {
          messageId: "m1",
          role: "user",
          turn: 1,
          contentBlocks: [
            { type: "text", text: "look at this" },
            { type: "resourceRef", resourceId: "f1" },
          ],
        },
        { messageId: "m2", role: "assistant", turn: 1, contentBlocks: [{ type: "text", text: "Here you go." }] },
      ],
    });
  });

  it("returns the 50 latest by default", async () => {
    const { app, services } = buildTestApp();
    services.threads.listMessages.mockResolvedValue([]);

    await app.inject({ method: "GET", url: "/courses/c1/threads/t1/messages", headers: AUTH });

    expect(services.threads.listMessages).toHaveBeenCalledWith("u1", "c1", "t1", 50);
  });

  it("takes a limit", async () => {
    const { app, services } = buildTestApp();
    services.threads.listMessages.mockResolvedValue([]);

    await app.inject({ method: "GET", url: "/courses/c1/threads/t1/messages?limit=10", headers: AUTH });

    expect(services.threads.listMessages).toHaveBeenCalledWith("u1", "c1", "t1", 10);
  });

  it.each(["0", "-1", "201", "abc"])("rejects a limit of %s with 400", async (limit) => {
    const { app, services } = buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: `/courses/c1/threads/t1/messages?limit=${limit}`,
      headers: AUTH,
    });

    expect(response.statusCode).toBe(400);
    expect(services.threads.listMessages).not.toHaveBeenCalled();
  });

  it("returns 404 for a thread the caller does not have", async () => {
    const { app, services } = buildTestApp();
    services.threads.listMessages.mockRejectedValue(new ThreadNotFoundError("t9"));

    const response = await app.inject({ method: "GET", url: "/courses/c1/threads/t9/messages", headers: AUTH });

    expect(response.statusCode).toBe(404);
  });
});

describe("POST /courses/:courseId/threads/:threadId/messages", () => {
  const events = async function* (...items: ChatEvent[]) {
    yield* items;
  };

  const send = (app: ReturnType<typeof buildTestApp>["app"], payload: unknown) =>
    app.inject({ method: "POST", url: "/courses/c1/threads/t1/messages", headers: AUTH, payload: payload as object });

  it("streams the reply as server-sent events", async () => {
    const { app, services } = buildTestApp();
    services.chat.sendMessage.mockResolvedValue(
      events(
        { type: "tool_status", message: "Reading Lab 2…" },
        { type: "text", text: "Hel" },
        { type: "text", text: "lo" },
        { type: "done", messageId: "m2", turn: 5 },
      ),
    );

    const response = await send(app, { text: "help me" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.body).toBe(
      'event: tool_status\ndata: {"message":"Reading Lab 2…"}\n\n' +
        'event: text\ndata: {"text":"Hel"}\n\n' +
        'event: text\ndata: {"text":"lo"}\n\n' +
        'event: done\ndata: {"messageId":"m2","turn":5}\n\n',
    );
  });

  it("sends the caller's id with the text and attachments", async () => {
    const { app, services } = buildTestApp();
    services.chat.sendMessage.mockResolvedValue(events({ type: "done", messageId: "m2", turn: 1 }));

    await send(app, { text: "help me", attachmentFileIds: ["f1", "f2"], userId: "someone-else" });

    expect(services.chat.sendMessage).toHaveBeenCalledWith("u1", "c1", "t1", {
      text: "help me",
      attachmentFileIds: ["f1", "f2"],
    });
  });

  it("sends a failure that happens mid-reply as an error event, since the response has already started", async () => {
    const { app, services } = buildTestApp();
    services.chat.sendMessage.mockResolvedValue(
      events(
        { type: "text", text: "partial" },
        { type: "error", message: "The assistant could not respond. Please try again." },
      ),
    );

    const response = await send(app, { text: "help me" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: error\ndata: {"message":"The assistant could not respond. Please try again."}');
  });

  it("returns 404 as a normal response when the thread is not the caller's", async () => {
    const { app, services } = buildTestApp();
    services.chat.sendMessage.mockRejectedValue(new ThreadNotFoundError("t1"));

    const response = await send(app, { text: "help me" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
  });

  it("returns 400 as a normal response when an attachment is not usable", async () => {
    const { app, services } = buildTestApp();
    services.chat.sendMessage.mockRejectedValue(new InvalidMessageError('Attachment "f9" is not available'));

    const response = await send(app, { text: "help me", attachmentFileIds: ["f9"] });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: 'Attachment "f9" is not available' });
  });

  it.each([
    ["no text", {}],
    ["empty text", { text: "" }],
    ["text that is too long", { text: "x".repeat(20_001) }],
    ["attachments that are not a list", { text: "hi", attachmentFileIds: "f1" }],
    ["too many attachments", { text: "hi", attachmentFileIds: ["a", "b", "c", "d", "e", "f"] }],
  ])("rejects %s with 400", async (_label, payload) => {
    const { app, services } = buildTestApp();

    const response = await send(app, payload);

    expect(response.statusCode).toBe(400);
    expect(services.chat.sendMessage).not.toHaveBeenCalled();
  });
});
