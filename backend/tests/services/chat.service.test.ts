import { describe, expect, it, vi } from "vitest";
import type { ModelEvent } from "../../src/clients/chat-model.js";
import type { CourseFile, Message, Thread } from "../../src/models/items.js";
import {
  ChatService,
  HISTORY_MESSAGE_LIMIT,
  InvalidMessageError,
  MAX_TOOL_ROUNDS,
  type ChatEvent,
} from "../../src/services/chat.service.js";
import { AssignmentNotFoundError } from "../../src/services/assignments.service.js";
import { ThreadNotFoundError } from "../../src/services/threads.service.js";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ref = { userId: "u1", courseId: "c1", threadId: "t1" };

const thread = (overrides: Partial<Thread> = {}): Thread => ({
  threadId: "t1",
  courseId: "c1",
  userId: "u1",
  title: "New chat",
  mode: "concept_review",
  turnCount: 2,
  pinnedResourceIds: [],
  activeResources: {},
  createdAt: "t",
  updatedAt: "t",
  ...overrides,
});

const file = (fileId: string, overrides: Partial<CourseFile> = {}): CourseFile =>
  ({
    fileId,
    userId: "u1",
    courseId: "c1",
    title: `File ${fileId}`,
    docType: "notes",
    status: "ready",
    summary: `Summary ${fileId}`,
    rawKey: `raw/u1/c1/${fileId}/original.pdf`,
    markdownKey: `processed/u1/c1/${fileId}/full.md`,
    mimeType: "application/pdf",
    tokenCount: 100,
    searchOnly: false,
    ...overrides,
  }) as CourseFile;

// a scripted model: each call to converse() plays the next list of events
const script = (...turns: ModelEvent[][]) => {
  const queue = [...turns];
  return vi.fn(async function* (_request?: any) {
    const next = queue.shift();
    if (!next) throw new Error("model called more times than scripted");
    yield* next;
  });
};
const reply = (...parts: string[]): ModelEvent[] => [
  ...parts.map((text) => ({ type: "text", text }) as ModelEvent),
  { type: "stop", reason: "end_turn" },
];
const toolCall = (toolUseId: string, name: string, input: Record<string, unknown>): ModelEvent[] => [
  { type: "tool_use", toolUseId, name, input },
  { type: "stop", reason: "tool_use" },
];

function build(
  options: {
    thread?: Thread | undefined;
    catalog?: CourseFile[];
    history?: Message[];
    assignment?: unknown;
    studyPreferences?: string | null;
  } = {},
) {
  const callOrder: string[] = [];
  // the student's profile, which is where their study preferences live. Users who predate the field have none at all.
  const users = {
    getUser: vi.fn(async () =>
      options.studyPreferences === undefined
        ? { userId: "u1", firstName: "Ada", lastName: "Lovelace" }
        : { userId: "u1", firstName: "Ada", lastName: "Lovelace", studyPreferences: options.studyPreferences },
    ),
  };
  // the assignments service refuses a missing or soft-deleted assignment with AssignmentNotFoundError
  const assignments = {
    getAssignment: vi.fn(async () => {
      if (options.assignment) return options.assignment;
      throw new AssignmentNotFoundError("a1");
    }),
  };
  const threads = {
    get: vi.fn().mockResolvedValue("thread" in options ? options.thread : thread()),
    incrementTurn: vi.fn(async () => {
      callOrder.push("incrementTurn");
      return 3;
    }),
  };
  const messages = {
    listRecent: vi.fn().mockResolvedValue(options.history ?? []),
    put: vi.fn(async (_threadId: string, message: Message) => {
      callOrder.push(`put:${message.role}`);
      return true;
    }),
  };
  const catalog = options.catalog ?? [file("f1")];
  const files = { listByCourse: vi.fn().mockResolvedValue(catalog) };
  const objects = {
    getText: vi.fn().mockResolvedValue("# markdown body"),
    getBytes: vi.fn().mockResolvedValue(new Uint8Array([9, 9])),
  };
  const tools = {
    execute: vi.fn().mockResolvedValue({ text: "tool output", summary: "Did the thing", resourceId: undefined }),
    describe: vi.fn().mockResolvedValue("Working…"),
  };
  const model = { converse: script(reply("Hello")) };
  const ids = ["m-user", "m-assistant"];
  const service = new ChatService({
    threads,
    messages,
    files,
    assignments,
    users,
    objects,
    tools,
    model,
    rawBucket: "raw-bucket",
    processedBucket: "processed-bucket",
    newId: () => ids.shift() ?? "m-extra",
    now: () => NOW,
  } as never);

  const send = async (input: { text: string; attachmentFileIds?: string[] } = { text: "hi" }) => {
    callOrder.length = 0;
    const stream = await service.sendMessage("u1", "c1", "t1", input);
    const events: ChatEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
  };
  return { service, send, threads, messages, files, assignments, users, objects, tools, model, callOrder };
}

describe("ChatService.sendMessage: before the model is called", () => {
  it("rejects an unknown thread, which also covers another user's thread, and writes nothing", async () => {
    const { service, messages, model, threads } = build({ thread: undefined });

    await expect(service.sendMessage("u1", "c1", "t9", { text: "hi" })).rejects.toThrow(ThreadNotFoundError);

    expect(threads.get).toHaveBeenCalledWith({ userId: "u1", courseId: "c1", threadId: "t9" });
    expect(messages.put).not.toHaveBeenCalled();
    expect(model.converse).not.toHaveBeenCalled();
  });

  it("treats a soft-deleted thread as not found", async () => {
    const { service } = build({ thread: thread({ deletedAt: "2026-10-02T00:00:00.000Z" }) });
    await expect(service.sendMessage("u1", "c1", "t1", { text: "hi" })).rejects.toThrow(ThreadNotFoundError);
  });

  it.each([
    ["does not exist in the course", []],
    ["is soft-deleted", [file("f1", { deletedAt: "2026-10-20T00:00:00.000Z" })]],
    ["is still processing", [file("f1", { status: "parsing" })]],
    ["failed to process", [file("f1", { status: "failed" })]],
  ])("rejects an attachment that %s, and writes nothing", async (_label, catalog) => {
    const { service, messages, model } = build({ catalog });

    await expect(service.sendMessage("u1", "c1", "t1", { text: "hi", attachmentFileIds: ["f1"] })).rejects.toThrow(
      InvalidMessageError,
    );

    expect(messages.put).not.toHaveBeenCalled();
    expect(model.converse).not.toHaveBeenCalled();
  });

  it("loads only the course catalog and recent history for this thread", async () => {
    const { send, files, messages } = build();

    await send();

    expect(files.listByCourse).toHaveBeenCalledWith("u1", "c1");
    expect(messages.listRecent).toHaveBeenCalledWith("t1", HISTORY_MESSAGE_LIMIT);
  });

  it("stores the user's message before calling the model", async () => {
    const { send, callOrder, model } = build();
    model.converse.mockImplementation(async function* () {
      callOrder.push("model");
      yield* reply("ok");
    });

    await send();

    expect(callOrder.slice(0, 2)).toEqual(["put:user", "model"]);
  });

  it("stores the user message as the next turn, with attachments as references", async () => {
    const { send, messages } = build({ catalog: [file("f1"), file("f2")] });

    await send({ text: "look at these", attachmentFileIds: ["f1", "f2"] });

    expect(messages.put).toHaveBeenNthCalledWith(1, "t1", {
      messageId: "m-user",
      role: "user",
      turn: 3,
      contentBlocks: [
        { type: "text", text: "look at these" },
        { type: "resourceRef", resourceId: "f1" },
        { type: "resourceRef", resourceId: "f2" },
      ],
      hydratedResourceIds: ["f1", "f2"],
    });
  });
});

describe("ChatService.sendMessage: the model call", () => {
  it("gives the model the course catalog and the attached file's text", async () => {
    const { send, model, objects } = build({ catalog: [file("f1", { title: "Lab 2 handout" }), file("f2")] });

    await send({ text: "help with this", attachmentFileIds: ["f1"] });

    expect(objects.getText).toHaveBeenCalledWith("processed-bucket", "processed/u1/c1/f1/full.md");
    const request = model.converse.mock.calls[0][0];
    expect(request.system).toContain("Lab 2 handout");
    expect(request.system).toContain("# markdown body");
    expect(request.system).toContain("File f2");
    expect(request.tools.map((t: { name: string }) => t.name)).toEqual([
      "search_course_materials",
      "get_resource",
      "load_resource",
    ]);
  });

  it("does not read the text of files that are not hydrated", async () => {
    const { send, objects } = build({ catalog: [file("f1"), file("f2")] });

    await send({ text: "hi", attachmentFileIds: ["f1"] });

    expect(objects.getText).toHaveBeenCalledTimes(1);
  });

  it("hydrates pinned files and unexpired active resources without being asked", async () => {
    const { send, model, objects } = build({
      thread: thread({
        turnCount: 2,
        pinnedResourceIds: ["f1"],
        activeResources: { f2: { loadedAtTurn: 1, expiresAfterTurn: 3 } },
      }),
      catalog: [file("f1"), file("f2")],
    });

    await send();

    expect(objects.getText).toHaveBeenCalledTimes(2);
    expect(model.converse.mock.calls[0][0].system).toContain("# markdown body");
  });

  it("sends an attached image as bytes read from S3", async () => {
    const image = file("f1", { docType: "image", rawKey: "raw/u1/c1/f1/original.png", mimeType: "image/png" });
    const { send, model, objects } = build({ catalog: [image] });

    await send({ text: "what is this?", attachmentFileIds: ["f1"] });

    expect(objects.getBytes).toHaveBeenCalledWith("raw-bucket", "raw/u1/c1/f1/original.png");
    const lastMessage = model.converse.mock.calls[0][0].messages.at(-1);
    expect(lastMessage.content).toEqual([
      { type: "image", format: "png", bytes: new Uint8Array([9, 9]) },
      { type: "text", text: "what is this?" },
    ]);
  });

  it("includes earlier messages before the new one", async () => {
    const history: Message[] = [
      { messageId: "m1", role: "user", turn: 1, contentBlocks: [{ type: "text", text: "earlier question" }], hydratedResourceIds: [] },
      { messageId: "m2", role: "assistant", turn: 1, contentBlocks: [{ type: "text", text: "earlier answer" }], hydratedResourceIds: [] },
    ];
    const { send, model } = build({ history });

    await send({ text: "follow up" });

    const texts = model.converse.mock.calls[0][0].messages.map((m: any) => m.content[0].text);
    expect(texts).toEqual(["earlier question", "earlier answer", "follow up"]);
  });
});

describe("ChatService.sendMessage: the student's study preferences", () => {
  it("gives the model the student's study preferences, in every conversation", async () => {
    const { send, model, users } = build({ studyPreferences: "I like short worked examples first." });

    await send();

    expect(users.getUser).toHaveBeenCalledWith("u1");
    expect(model.converse.mock.calls[0][0].system).toContain("I like short worked examples first.");
  });

  it("reads them on every turn, so a change takes effect in a conversation that is already running", async () => {
    const { send, users, model } = build({ studyPreferences: "First version." });
    model.converse = vi.fn(async function* () {
      yield { type: "text", text: "ok" } as never;
      yield { type: "stop", reason: "end_turn" } as never;
    });

    await send();
    users.getUser.mockResolvedValue({ userId: "u1", studyPreferences: "Second version." } as never);
    await send();

    expect(model.converse.mock.calls[0][0].system).toContain("First version.");
    expect(model.converse.mock.calls[1][0].system).toContain("Second version.");
    expect(model.converse.mock.calls[1][0].system).not.toContain("First version.");
  });

  it.each([null, undefined])("carries on as normal when the student has none (%s)", async (value) => {
    const { send, model } = build({ studyPreferences: value });

    const events = await send();

    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(model.converse.mock.calls[0][0].system).not.toMatch(/undefined|null/);
  });

  it("is added alongside an assignment, not instead of it", async () => {
    const { send, model } = build({
      thread: thread({ assignmentId: "a1" }),
      assignment: { assignmentId: "a1", title: "Lab 2", description: "", dueAt: "2026-11-01T22:00:00.000Z" },
      studyPreferences: "Short answers.",
    });

    await send();

    const { system } = model.converse.mock.calls[0][0];
    expect(system).toContain("Short answers.");
    expect(system).toContain("Lab 2");
  });

  it("is read for the signed-in user, never for a user the request names", async () => {
    const { service, users } = build();

    const stream = await service.sendMessage("u1", "c1", "t1", { text: "hi" });
    for await (const _event of stream) {
      // drain
    }

    expect(users.getUser).toHaveBeenCalledTimes(1);
    expect(users.getUser).toHaveBeenCalledWith("u1");
  });

  it("fails the turn, rather than carrying on without them, when the profile cannot be read", async () => {
    const { service, users, messages } = build();
    users.getUser.mockRejectedValue(new Error("dynamo down"));

    await expect(service.sendMessage("u1", "c1", "t1", { text: "hi" })).rejects.toThrow("dynamo down");

    expect(messages.put).not.toHaveBeenCalled();
  });
});

describe("ChatService.sendMessage: a thread about an assignment", () => {
  const assignment = {
    assignmentId: "a1",
    courseId: "c1",
    title: "Lab 2: Greedy scheduling",
    description: "Implement interval scheduling.",
    dueAt: "2026-11-01T22:00:00.000Z",
  };

  it("gives the model the assignment's title, description and due date", async () => {
    const { send, model, assignments } = build({ thread: thread({ assignmentId: "a1" }), assignment });

    await send();

    expect(assignments.getAssignment).toHaveBeenCalledWith("u1", "c1", "a1");
    const { system } = model.converse.mock.calls[0][0];
    expect(system).toContain("Lab 2: Greedy scheduling");
    expect(system).toContain("Implement interval scheduling.");
    expect(system).toContain("2026-11-01T22:00:00.000Z");
  });

  it("does not look up an assignment when the thread is not about one", async () => {
    const { send, assignments } = build({ assignment });

    await send();

    expect(assignments.getAssignment).not.toHaveBeenCalled();
  });

  it("carries on without it when the assignment is gone or has been deleted, instead of failing the chat", async () => {
    const { send, model } = build({ thread: thread({ assignmentId: "a1" }), assignment: undefined });

    const events = await send();

    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(model.converse.mock.calls[0][0].system).not.toContain("Lab 2");
  });

  it("fails the turn, rather than hiding it, when the assignment cannot be read for any other reason", async () => {
    const { service, assignments, messages } = build({ thread: thread({ assignmentId: "a1" }) });
    assignments.getAssignment.mockRejectedValue(new Error("dynamo down"));

    await expect(service.sendMessage("u1", "c1", "t1", { text: "hi" })).rejects.toThrow("dynamo down");

    expect(messages.put).not.toHaveBeenCalled();
  });

  it("still pins the assignment's files, which came from the thread, whether or not the assignment still exists", async () => {
    const { send, model } = build({
      thread: thread({ assignmentId: "a1", pinnedResourceIds: ["f1"] }),
      assignment: undefined,
    });

    await send();

    expect(model.converse.mock.calls[0][0].system).toContain("# markdown body");
  });
});

describe("ChatService.sendMessage: the reply", () => {
  it("streams the text as it arrives and ends with done", async () => {
    const { send, model } = build();
    model.converse = script(reply("Hel", "lo ", "there"));

    const events = await send();

    expect(events).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo " },
      { type: "text", text: "there" },
      { type: "done", messageId: "m-assistant", turn: 3 },
    ]);
  });

  it("stores the whole reply as one assistant message on the same turn as the question", async () => {
    const { send, messages, model } = build();
    model.converse = script(reply("Hel", "lo"));

    await send();

    expect(messages.put).toHaveBeenNthCalledWith(2, "t1", {
      messageId: "m-assistant",
      role: "assistant",
      turn: 3,
      contentBlocks: [{ type: "text", text: "Hello" }],
      hydratedResourceIds: [],
    });
  });

  it("counts the turn only after the reply is stored", async () => {
    const { send, callOrder, threads } = build();

    await send();

    expect(callOrder).toEqual(["put:user", "put:assistant", "incrementTurn"]);
    expect(threads.incrementTurn).toHaveBeenCalledWith(ref);
  });
});

describe("ChatService.sendMessage: tools", () => {
  it("runs a requested tool, tells the client what it is doing, and sends the result back to the model", async () => {
    const { send, model, tools } = build();
    model.converse = script(
      toolCall("tu1", "get_resource", { resource_id: "f1" }),
      reply("Here is what it says."),
    );
    tools.describe.mockResolvedValue("Reading File f1…");
    tools.execute.mockResolvedValue({ text: "FULL FILE TEXT", summary: 'Read "File f1"', resourceId: "f1" });

    const events = await send();

    expect(events).toEqual([
      { type: "tool_status", message: "Reading File f1…" },
      { type: "text", text: "Here is what it says." },
      { type: "done", messageId: "m-assistant", turn: 3 },
    ]);
    const second = model.converse.mock.calls[1][0].messages;
    expect(second.at(-2)).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", toolUseId: "tu1", name: "get_resource", input: { resource_id: "f1" } }],
    });
    expect(second.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "tu1", text: "FULL FILE TEXT", isError: false }],
    });
  });

  it("runs tools as the session's user in the session's course, whatever the model asked for", async () => {
    const { send, model, tools } = build({ thread: thread({ turnCount: 5, activeResources: { f1: { loadedAtTurn: 4, expiresAfterTurn: 9 } } }) });
    model.converse = script(
      toolCall("tu1", "search_course_materials", { query: "x", user_id: "someone-else", course_id: "c9" }),
      reply("done"),
    );

    await send();

    expect(tools.execute).toHaveBeenCalledWith(
      {
        userId: "u1",
        courseId: "c1",
        threadId: "t1",
        turn: 6,
        activeResources: { f1: { loadedAtTurn: 4, expiresAfterTurn: 9 } },
      },
      { name: "search_course_materials", input: { query: "x", user_id: "someone-else", course_id: "c9" } },
    );
  });

  it("passes tool errors back to the model as errors", async () => {
    const { send, model, tools } = build();
    model.converse = script(toolCall("tu1", "get_resource", { resource_id: "nope" }), reply("Sorry."));
    tools.execute.mockResolvedValue({ text: 'File "nope" not found', summary: "Could not read nope", isError: true });

    await send();

    expect(model.converse.mock.calls[1][0].messages.at(-1).content[0]).toMatchObject({
      type: "tool_result",
      isError: true,
    });
  });

  it("stores references to tool activity, never the content a tool returned", async () => {
    const { send, messages, model, tools } = build();
    model.converse = script(
      [{ type: "text", text: "Let me check. " }, ...toolCall("tu1", "get_resource", { resource_id: "f1" })],
      reply("Done."),
    );
    tools.execute.mockResolvedValue({ text: "SECRET FILE CONTENT", summary: 'Read "File f1"', resourceId: "f1" });

    await send();

    const stored = messages.put.mock.calls[1][1] as Message;
    expect(stored.contentBlocks).toEqual([
      { type: "text", text: "Let me check. " },
      { type: "toolCall", toolUseId: "tu1", name: "get_resource", input: { resource_id: "f1" } },
      { type: "toolResultRef", toolUseId: "tu1", resourceId: "f1", summary: 'Read "File f1"' },
      { type: "text", text: "Done." },
    ]);
    expect(JSON.stringify(stored)).not.toContain("SECRET FILE CONTENT");
  });

  it("handles several tool calls in one model turn", async () => {
    const { send, model, tools } = build();
    model.converse = script(
      [
        { type: "tool_use", toolUseId: "a", name: "get_resource", input: { resource_id: "f1" } },
        { type: "tool_use", toolUseId: "b", name: "get_resource", input: { resource_id: "f2" } },
        { type: "stop", reason: "tool_use" },
      ],
      reply("ok"),
    );

    await send();

    expect(tools.execute).toHaveBeenCalledTimes(2);
    const results = model.converse.mock.calls[1][0].messages.at(-1).content;
    expect(results.map((r: any) => r.toolUseId)).toEqual(["a", "b"]);
  });

  it(`stops offering tools after ${MAX_TOOL_ROUNDS} rounds so the reply always finishes`, async () => {
    const { send, model } = build();
    const rounds = Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) =>
      toolCall(`tu${i}`, "search_course_materials", { query: "again" }),
    );
    model.converse = script(...rounds, reply("Final answer."));

    const events = await send();

    expect(model.converse).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1);
    expect(model.converse.mock.calls.at(-1)?.[0].tools).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });
});

describe("ChatService.sendMessage: failures", () => {
  it("reports a model failure as an error event with a safe message, and does not store a reply or count the turn", async () => {
    const { send, messages, threads, model } = build();
    model.converse = vi.fn(async function* () {
      yield { type: "text", text: "partial" } as ModelEvent;
      throw new Error("ThrottlingException: secret internals");
    });

    const events = await send();

    expect(events.at(-1)).toEqual({ type: "error", message: "The assistant could not respond. Please try again." });
    expect(JSON.stringify(events)).not.toContain("secret internals");
    expect(messages.put).toHaveBeenCalledTimes(1); // only the user's message
    expect(threads.incrementTurn).not.toHaveBeenCalled();
  });

  it("reports a failing tool the same way", async () => {
    const { send, model, tools, threads } = build();
    model.converse = script(toolCall("tu1", "get_resource", { resource_id: "f1" }));
    tools.execute.mockRejectedValue(new Error("boom"));

    const events = await send();

    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(threads.incrementTurn).not.toHaveBeenCalled();
  });

  it("does not leave the next turn counted twice if the reply could not be stored", async () => {
    const { send, messages, threads } = build();
    messages.put.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("dynamo down"));

    const events = await send();

    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(threads.incrementTurn).not.toHaveBeenCalled();
  });
});
