import { describe, expect, it } from "vitest";
import { HISTORY_BUDGET_TOKENS, buildPrompt } from "../../src/chat/prompt.js";
import type { CourseFile, Message, ThreadMode } from "../../src/models/items.js";

const file = (fileId: string, overrides: Partial<CourseFile> = {}): CourseFile =>
  ({
    fileId,
    userId: "u1",
    courseId: "c1",
    title: `Title ${fileId}`,
    docType: "notes",
    summary: `Summary of ${fileId}`,
    status: "ready",
    tokenCount: 100,
    searchOnly: false,
    ...overrides,
  }) as CourseFile;

const message = (messageId: string, role: "user" | "assistant", text: string, turn = 1): Message => ({
  messageId,
  role,
  turn,
  contentBlocks: [{ type: "text", text }],
  hydratedResourceIds: [],
});

const build = (overrides: Partial<Parameters<typeof buildPrompt>[0]> = {}) =>
  buildPrompt({
    mode: "concept_review",
    catalog: [],
    documents: [],
    images: [],
    history: [],
    text: "What is a greedy algorithm?",
    ...overrides,
  });

describe("buildPrompt system prompt", () => {
  it("is different for each mode", () => {
    const modes: ThreadMode[] = ["assignment_help", "exam_prep", "concept_review"];
    const prompts = modes.map((mode) => build({ mode }).system);

    expect(new Set(prompts).size).toBe(3);
  });

  it("tells the model its scope is one course and to use the tools for anything not in front of it", () => {
    const { system } = build();

    expect(system).toContain("search_course_materials");
    expect(system).toContain("get_resource");
    expect(system).toContain("load_resource");
  });

  it("lists every ready file in the catalog with its title, type, summary and id", () => {
    const { system } = build({
      catalog: [file("f1", { title: "Lab 2 handout", docType: "assignment", summary: "Greedy lab." })],
    });

    expect(system).toContain("f1");
    expect(system).toContain("Lab 2 handout");
    expect(system).toContain("assignment");
    expect(system).toContain("Greedy lab.");
  });

  it("leaves out files that are not ready or are deleted", () => {
    const { system } = build({
      catalog: [
        file("f1", { title: "Visible" }),
        file("f2", { title: "Still parsing", status: "parsing" }),
        file("f3", { title: "Failed upload", status: "failed" }),
        file("f4", { title: "Removed", deletedAt: "2026-10-20T00:00:00.000Z" }),
      ],
    });

    expect(system).toContain("Visible");
    expect(system).not.toContain("Still parsing");
    expect(system).not.toContain("Failed upload");
    expect(system).not.toContain("Removed");
  });

  it("marks catalog entries as included, readable on request, or search-only", () => {
    const hydrated = file("f1", { title: "Included one" });
    const { system } = build({
      catalog: [
        hydrated,
        file("f2", { title: "Readable one" }),
        file("f3", { title: "Big book", docType: "textbook", searchOnly: true }),
      ],
      documents: [{ file: hydrated, markdown: "# Included body" }],
    });

    const lineFor = (title: string) => system.split("\n").find((line) => line.includes(title)) ?? "";
    expect(lineFor("Included one")).toMatch(/included below/i);
    expect(lineFor("Readable one")).toContain("get_resource");
    expect(lineFor("Big book")).toContain("search_course_materials");
    expect(lineFor("Big book")).not.toContain("get_resource");
  });

  it("puts the mode prompt first, then the catalog, then the hydrated files", () => {
    const doc = file("f1");
    const { system } = build({
      catalog: [doc],
      documents: [{ file: doc, markdown: "HYDRATED-BODY" }],
    });

    expect(system.indexOf("Title f1")).toBeGreaterThan(system.indexOf("search_course_materials"));
    expect(system.indexOf("HYDRATED-BODY")).toBeGreaterThan(system.indexOf("Title f1"));
  });

  it("includes hydrated documents in the order given, so the prefix is stable between turns", () => {
    const a = file("f1");
    const b = file("f2");

    const { system } = build({
      catalog: [a, b],
      documents: [
        { file: a, markdown: "BODY-A" },
        { file: b, markdown: "BODY-B" },
      ],
    });

    expect(system.indexOf("BODY-A")).toBeLessThan(system.indexOf("BODY-B"));
  });

  it("is identical for identical input", () => {
    const input = { catalog: [file("f1")], documents: [{ file: file("f1"), markdown: "x" }] };
    expect(build(input).system).toBe(build(input).system);
  });
});

describe("buildPrompt study preferences", () => {
  const preferences = "I learn best from short worked examples, then a practice question.";

  it("puts the student's own words about how they like to study in the system prompt", () => {
    const { system } = build({ studyPreferences: preferences });

    expect(system).toContain(preferences);
  });

  it("is the same in every mode, since it is about the student and not the task", () => {
    for (const mode of ["assignment_help", "exam_prep", "concept_review"] as const) {
      expect(build({ mode, studyPreferences: preferences }).system).toContain(preferences);
    }
  });

  it("keeps line breaks in the text", () => {
    const { system } = build({ studyPreferences: "Short answers.\nThen a quiz question." });

    expect(system).toContain("Short answers.\nThen a quiz question.");
  });

  it.each([null, undefined, "", "   \n"])("adds nothing for %j, and prints no blank section or the word undefined", (value) => {
    const { system } = build({ studyPreferences: value as never });

    expect(system).toBe(build().system);
    expect(system).not.toMatch(/undefined|null/);
  });

  it("comes after the mode's rules, so the rules for the task stay first, and before the course materials", () => {
    const { system } = build({
      mode: "assignment_help",
      studyPreferences: preferences,
      catalog: [file("f1", { title: "Catalog entry" })],
    });

    expect(system.indexOf("Mode: assignment help")).toBeLessThan(system.indexOf(preferences));
    expect(system.indexOf(preferences)).toBeLessThan(system.indexOf("Catalog entry"));
  });

  it("is framed as the student's preferences about style, which do not change what the assistant must do", () => {
    const { system } = build({ studyPreferences: preferences });

    const before = system.slice(0, system.indexOf(preferences)).toLowerCase();
    expect(before).toMatch(/prefer/);
    expect(before).toMatch(/do not (change|override)|cannot (change|override)|never override|only .*(style|how)/);
  });

  it("comes before the assignment, and both are present together", () => {
    const { system } = build({
      studyPreferences: preferences,
      assignment: { title: "Lab 2", description: "", dueAt: "2026-11-01T22:00:00.000Z" },
    });

    expect(system).toContain(preferences);
    expect(system).toContain("Lab 2");
    expect(system.indexOf(preferences)).toBeLessThan(system.indexOf("Lab 2"));
  });

  it("is identical for identical input", () => {
    expect(build({ studyPreferences: preferences }).system).toBe(build({ studyPreferences: preferences }).system);
  });
});

describe("buildPrompt assignment", () => {
  const assignment = {
    title: "Lab 2: Greedy scheduling",
    description: "Implement interval scheduling and prove it is optimal.",
    dueAt: "2026-11-01T22:00:00.000Z",
  };

  it("puts the assignment's title, description and due date in the system prompt", () => {
    const { system } = build({ mode: "assignment_help", assignment });

    expect(system).toContain("Lab 2: Greedy scheduling");
    expect(system).toContain("Implement interval scheduling and prove it is optimal.");
    expect(system).toContain("2026-11-01T22:00:00.000Z");
  });

  it("leaves the description out when there is none, without printing a blank or the word undefined", () => {
    const { system } = build({ mode: "assignment_help", assignment: { ...assignment, description: "" } });

    expect(system).toContain("Lab 2: Greedy scheduling");
    expect(system).toContain("2026-11-01T22:00:00.000Z");
    expect(system).not.toMatch(/undefined|null/);
  });

  it("comes before the course materials, so the materials are read in light of it", () => {
    const { system } = build({
      assignment,
      catalog: [file("f1", { title: "Catalog entry" })],
    });

    expect(system.indexOf("Lab 2: Greedy scheduling")).toBeGreaterThan(-1);
    expect(system.indexOf("Lab 2: Greedy scheduling")).toBeLessThan(system.indexOf("Catalog entry"));
  });

  it("says nothing about an assignment when the thread is not about one", () => {
    expect(build().system).not.toContain("2026-11-01T22:00:00.000Z");
    expect(build({ assignment: undefined }).system).toBe(build().system);
  });

  it("is identical for identical input", () => {
    expect(build({ assignment }).system).toBe(build({ assignment }).system);
  });
});

describe("buildPrompt messages", () => {
  it("ends with the new user message", () => {
    const { messages } = build({ text: "Explain Kruskal's." });

    expect(messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "Explain Kruskal's." }] });
  });

  it("puts history before the new message, in order", () => {
    const { messages } = build({
      history: [message("m1", "user", "first", 1), message("m2", "assistant", "second", 1)],
      text: "third",
    });

    expect(messages.map((m) => [m.role, (m.content[0] as { text: string }).text])).toEqual([
      ["user", "first"],
      ["assistant", "second"],
      ["user", "third"],
    ]);
  });

  it("attaches images to the new message", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { messages } = build({
      images: [{ file: file("f1", { docType: "image", mimeType: "image/png" }), bytes }],
    });

    expect(messages.at(-1)?.content).toEqual([
      { type: "image", format: "png", bytes },
      { type: "text", text: "What is a greedy algorithm?" },
    ]);
  });

  it.each([
    ["image/png", "png"],
    ["image/jpeg", "jpeg"],
    ["image/webp", "webp"],
    ["image/gif", "gif"],
  ])("sends a %s image as %s", (mimeType, format) => {
    const { messages } = build({
      images: [{ file: file("f1", { docType: "image", mimeType }), bytes: new Uint8Array([1]) }],
    });

    expect(messages.at(-1)?.content[0]).toMatchObject({ type: "image", format });
  });

  it("replaces stored tool activity in history with a one-line note, never with content", () => {
    const history: Message[] = [
      message("m1", "user", "find the lab", 1),
      {
        messageId: "m2",
        role: "assistant",
        turn: 1,
        contentBlocks: [
          { type: "toolCall", toolUseId: "t1", name: "get_resource", input: { resource_id: "f1" } },
          { type: "toolResultRef", toolUseId: "t1", resourceId: "f1", summary: 'Read "Lab 2 handout"' },
          { type: "text", text: "Here is the lab." },
        ],
        hydratedResourceIds: [],
      },
    ];

    const { messages } = build({ history });

    const assistant = messages[1];
    expect(assistant.role).toBe("assistant");
    const types = assistant.content.map((block) => block.type);
    expect(types).not.toContain("tool_use");
    expect(types).not.toContain("tool_result");
    const text = assistant.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    expect(text).toContain('Read "Lab 2 handout"');
    expect(text).toContain("Here is the lab.");
  });

  it("replaces an attachment reference in history with a placeholder naming the file", () => {
    const history: Message[] = [
      {
        messageId: "m1",
        role: "user",
        turn: 1,
        contentBlocks: [
          { type: "text", text: "look at this" },
          { type: "resourceRef", resourceId: "f1" },
        ],
        hydratedResourceIds: ["f1"],
      },
    ];

    const { messages } = build({ history, catalog: [file("f1", { title: "Lab 2 handout" })] });

    const text = messages[0].content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    expect(text).toContain("look at this");
    expect(text).toContain("Lab 2 handout");
  });

  it("drops the oldest messages once history exceeds its token budget, keeping the newest", () => {
    const long = "x".repeat(HISTORY_BUDGET_TOKENS * 4 * 0.4); // ~40% of the budget each
    const history = [
      message("m1", "user", `old ${long}`, 1),
      message("m2", "assistant", `old ${long}`, 1),
      message("m3", "user", `mid ${long}`, 2),
      message("m4", "assistant", `mid ${long}`, 2),
      message("m5", "user", "recent question", 3),
      message("m6", "assistant", "recent answer", 3),
    ];

    const { messages } = build({ history });

    const texts = messages.map((m) => m.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
    expect(texts.some((t) => t.startsWith("old"))).toBe(false);
    expect(texts.some((t) => t.includes("recent question"))).toBe(true);
    expect(texts.some((t) => t.includes("recent answer"))).toBe(true);
  });

  it("never starts the conversation on an assistant message after truncating", () => {
    const long = "x".repeat(HISTORY_BUDGET_TOKENS * 4 * 0.6);
    const history = [
      message("m1", "user", long, 1),
      message("m2", "assistant", "answer that would otherwise be first", 1),
      message("m3", "user", "next", 2),
      message("m4", "assistant", "next answer", 2),
    ];

    const { messages } = build({ history });

    expect(messages[0].role).toBe("user");
  });

  it("alternates roles, merging adjacent messages from the same role", () => {
    // happens when an assistant reply failed and was never stored
    const { messages } = build({
      history: [message("m1", "user", "question one", 1), message("m2", "user", "question two", 2)],
    });

    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role).not.toBe(messages[i - 1].role);
    }
    const joined = messages.flatMap((m) => m.content).map((b) => (b.type === "text" ? b.text : "")).join(" ");
    expect(joined).toContain("question one");
    expect(joined).toContain("question two");
  });
});
