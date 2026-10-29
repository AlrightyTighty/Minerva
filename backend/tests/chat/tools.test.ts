import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE_RESOURCE_TURNS,
  CourseTools,
  MAX_ACTIVE_RESOURCES,
  TOOL_SPECS,
  type ToolContext,
} from "../../src/chat/tools.js";
import type { CourseFile } from "../../src/models/items.js";

const file = (fileId: string, overrides: Partial<CourseFile> = {}): CourseFile =>
  ({
    fileId,
    userId: "u1",
    courseId: "c1",
    title: `File ${fileId}`,
    docType: "notes",
    status: "ready",
    markdownKey: `processed/u1/c1/${fileId}/full.md`,
    tokenCount: 500,
    searchOnly: false,
    ...overrides,
  }) as CourseFile;

const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  userId: "u1",
  courseId: "c1",
  threadId: "t1",
  turn: 4,
  activeResources: {},
  ...overrides,
});

function build(stored: CourseFile[] = [file("f1")]) {
  const files = {
    get: vi.fn(async (ref: { userId: string; courseId: string; fileId: string }) =>
      stored.find((f) => f.fileId === ref.fileId && f.userId === ref.userId && f.courseId === ref.courseId),
    ),
  };
  const search = { retrieve: vi.fn().mockResolvedValue([]) };
  const objects = { getText: vi.fn().mockResolvedValue("# The markdown") };
  const threads = {
    setActiveResource: vi.fn().mockResolvedValue(undefined),
    removeActiveResources: vi.fn().mockResolvedValue(undefined),
  };
  const tools = new CourseTools({ files, search, objects, threads, processedBucket: "processed-bucket" } as never);
  return { tools, files, search, objects, threads };
}

describe("TOOL_SPECS", () => {
  it("exposes the three course tools", () => {
    expect(TOOL_SPECS.map((spec) => spec.name)).toEqual(["search_course_materials", "get_resource", "load_resource"]);
  });

  it("never lets the model name a user or course", () => {
    const schema = JSON.stringify(TOOL_SPECS);
    expect(schema).not.toMatch(/user_id|userId|course_id|courseId/);
  });

  it("requires a query for search and a resource_id for get and load", () => {
    const required = Object.fromEntries(TOOL_SPECS.map((s) => [s.name, (s.inputSchema as any).required]));
    expect(required).toEqual({
      search_course_materials: ["query"],
      get_resource: ["resource_id"],
      load_resource: ["resource_id"],
    });
  });
});

describe("search_course_materials", () => {
  const hit = { text: "Greedy picks the local optimum.", score: 0.8, fileId: "f1" };

  it("searches only the session's user and course", async () => {
    const { tools, search } = build();

    await tools.execute(context({ userId: "u1", courseId: "c1" }), {
      name: "search_course_materials",
      input: { query: "greedy" },
    });

    expect(search.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ query: "greedy", filter: { userId: "u1", courseId: "c1" } }),
    );
  });

  it("lets the model narrow the search, never widen it", async () => {
    const { tools, search } = build();

    await tools.execute(context(), {
      name: "search_course_materials",
      input: {
        query: "greedy",
        resource_id: "f1",
        doc_type: "textbook",
        // none of these may take effect
        user_id: "someone-else",
        userId: "someone-else",
        course_id: "other-course",
        courseId: "other-course",
        filter: { anything: true },
      },
    });

    expect(search.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { userId: "u1", courseId: "c1", fileId: "f1", docType: "textbook" },
      }),
    );
  });

  it("returns the matching passages with the title and id of the file each came from", async () => {
    const { tools, search } = build([file("f1", { title: "Greedy algorithms" })]);
    search.retrieve.mockResolvedValue([hit]);

    const result = await tools.execute(context(), { name: "search_course_materials", input: { query: "greedy" } });

    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("Greedy picks the local optimum.");
    expect(result.text).toContain("Greedy algorithms");
    expect(result.text).toContain("f1");
  });

  it("says so when nothing matches", async () => {
    const { tools } = build();

    const result = await tools.execute(context(), { name: "search_course_materials", input: { query: "nothing" } });

    expect(result.isError).toBeFalsy();
    expect(result.text).toMatch(/no results/i);
  });

  it("summarises the search for storage without including any retrieved text", async () => {
    const { tools, search } = build();
    search.retrieve.mockResolvedValue([hit, { ...hit, text: "second passage" }]);

    const result = await tools.execute(context(), { name: "search_course_materials", input: { query: "greedy" } });

    expect(result.summary).toContain("greedy");
    expect(result.summary).toContain("2");
    expect(result.summary).not.toContain("local optimum");
    expect(result.summary).not.toContain("second passage");
  });

  it("asks for a query when the model sends none", async () => {
    const { tools, search } = build();

    const result = await tools.execute(context(), { name: "search_course_materials", input: {} });

    expect(result.isError).toBe(true);
    expect(search.retrieve).not.toHaveBeenCalled();
  });
});

describe.each(["get_resource", "load_resource"] as const)("%s", (name) => {
  const call = (resourceId: unknown = "f1") => ({ name, input: { resource_id: resourceId } });

  it("returns the file's Markdown from the processed bucket", async () => {
    const { tools, objects } = build([file("f1", { title: "Lab 2 handout" })]);

    const result = await tools.execute(context(), call());

    expect(objects.getText).toHaveBeenCalledWith("processed-bucket", "processed/u1/c1/f1/full.md");
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("# The markdown");
    expect(result.text).toContain("Lab 2 handout");
    expect(result.resourceId).toBe("f1");
  });

  it("stores a one-line summary that names the file but holds none of its content", async () => {
    const { tools } = build([file("f1", { title: "Lab 2 handout" })]);

    const result = await tools.execute(context(), call());

    expect(result.summary).toContain("Lab 2 handout");
    expect(result.summary).not.toContain("# The markdown");
  });

  it("looks the file up under the session's user and course, so other users' files are not found", async () => {
    const { tools, files, objects } = build([file("f1", { userId: "someone-else" })]);

    const result = await tools.execute(context({ userId: "u1" }), call());

    expect(files.get).toHaveBeenCalledWith({ userId: "u1", courseId: "c1", fileId: "f1" });
    expect(result.isError).toBe(true);
    expect(objects.getText).not.toHaveBeenCalled();
  });

  it("reports a file from another course as not found", async () => {
    const { tools, objects } = build([file("f1", { courseId: "other-course" })]);

    const result = await tools.execute(context({ courseId: "c1" }), call());

    expect(result.isError).toBe(true);
    expect(objects.getText).not.toHaveBeenCalled();
  });

  it.each([
    ["does not exist", []],
    ["is soft-deleted", [file("f1", { deletedAt: "2026-10-20T00:00:00.000Z" })]],
    ["is still processing", [file("f1", { status: "parsing" })]],
    ["failed to process", [file("f1", { status: "failed" })]],
  ])("refuses a file that %s, as a tool error the model can read", async (_label, stored) => {
    const { tools, objects } = build(stored);

    const result = await tools.execute(context(), call());

    expect(result.isError).toBe(true);
    expect(result.text).toContain("f1");
    expect(objects.getText).not.toHaveBeenCalled();
  });

  it("refuses search-only files and points the model at search instead", async () => {
    const { tools, objects } = build([file("f1", { docType: "textbook", searchOnly: true })]);

    const result = await tools.execute(context(), call());

    expect(result.isError).toBe(true);
    expect(result.text).toContain("search_course_materials");
    expect(objects.getText).not.toHaveBeenCalled();
  });

  it("refuses images, which are attached to a message and not read as text", async () => {
    const { tools, objects } = build([file("f1", { docType: "image", markdownKey: undefined })]);

    const result = await tools.execute(context(), call());

    expect(result.isError).toBe(true);
    expect(objects.getText).not.toHaveBeenCalled();
  });

  it("asks for a resource_id when the model sends none", async () => {
    const { tools } = build();

    const result = await tools.execute(context(), { name, input: {} });

    expect(result.isError).toBe(true);
  });
});

describe("get_resource", () => {
  it("does not change which resources stay loaded", async () => {
    const { tools, threads } = build();

    await tools.execute(context(), { name: "get_resource", input: { resource_id: "f1" } });

    expect(threads.setActiveResource).not.toHaveBeenCalled();
    expect(threads.removeActiveResources).not.toHaveBeenCalled();
  });
});

describe("load_resource", () => {
  const load = (tools: CourseTools, ctx: ToolContext, id = "f1") =>
    tools.execute(ctx, { name: "load_resource", input: { resource_id: id } });

  it("keeps the file loaded for the next few turns", async () => {
    const { tools, threads } = build();

    await load(tools, context({ turn: 4 }));

    expect(threads.setActiveResource).toHaveBeenCalledWith(
      { userId: "u1", courseId: "c1", threadId: "t1" },
      "f1",
      { loadedAtTurn: 4, expiresAfterTurn: 4 + ACTIVE_RESOURCE_TURNS },
    );
  });

  it("extends the expiry, and keeps the original load turn, when the file is loaded again", async () => {
    const { tools, threads } = build();

    await load(tools, context({ turn: 6, activeResources: { f1: { loadedAtTurn: 4, expiresAfterTurn: 6 } } }));

    expect(threads.setActiveResource).toHaveBeenCalledWith(expect.anything(), "f1", {
      loadedAtTurn: 4,
      expiresAfterTurn: 6 + ACTIVE_RESOURCE_TURNS,
    });
  });

  it("does not load a file that was refused", async () => {
    const { tools, threads } = build([file("f1", { searchOnly: true })]);

    await load(tools, context());

    expect(threads.setActiveResource).not.toHaveBeenCalled();
  });

  it(`evicts the soonest-expiring file when more than ${MAX_ACTIVE_RESOURCES} would be loaded`, async () => {
    const stored = ["f1", "f2", "f3", "f4"].map((id) => file(id));
    const { tools, threads } = build(stored);
    const active = {
      f1: { loadedAtTurn: 1, expiresAfterTurn: 9 },
      f2: { loadedAtTurn: 2, expiresAfterTurn: 6 }, // soonest to expire
      f3: { loadedAtTurn: 3, expiresAfterTurn: 8 },
    };

    await load(tools, context({ turn: 4, activeResources: active }), "f4");

    expect(threads.setActiveResource).toHaveBeenCalledWith(expect.anything(), "f4", expect.anything());
    expect(threads.removeActiveResources).toHaveBeenCalledWith(
      { userId: "u1", courseId: "c1", threadId: "t1" },
      ["f2"],
    );
  });

  it("does not count expired resources toward the cap, and clears them out", async () => {
    const stored = ["f1", "f2", "f3", "f4"].map((id) => file(id));
    const { tools, threads } = build(stored);
    const active = {
      f1: { loadedAtTurn: 1, expiresAfterTurn: 2 }, // expired at turn 4
      f2: { loadedAtTurn: 1, expiresAfterTurn: 9 },
      f3: { loadedAtTurn: 1, expiresAfterTurn: 9 },
    };

    await load(tools, context({ turn: 4, activeResources: active }), "f4");

    expect(threads.removeActiveResources).toHaveBeenCalledWith(expect.anything(), ["f1"]);
  });

  it("does not evict anything while under the cap", async () => {
    const { tools, threads } = build();

    await load(tools, context());

    expect(threads.removeActiveResources).not.toHaveBeenCalled();
  });
});

describe("execute", () => {
  it("returns a tool error for a tool it does not have, instead of throwing", async () => {
    const { tools } = build();

    const result = await tools.execute(context(), { name: "delete_everything", input: {} });

    expect(result.isError).toBe(true);
  });

  it("returns a tool error when a lookup fails unexpectedly, instead of throwing", async () => {
    const { tools, files } = build();
    files.get.mockRejectedValue(new Error("dynamo down"));

    const result = await tools.execute(context(), { name: "get_resource", input: { resource_id: "f1" } });

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("dynamo down");
  });
});

describe("describe", () => {
  it("names the file being read, so the client can show 'Reading Lab 2 handout…'", async () => {
    const { tools } = build([file("f1", { title: "Lab 2 handout" })]);

    await expect(tools.describe(context(), { name: "get_resource", input: { resource_id: "f1" } })).resolves.toBe(
      "Reading Lab 2 handout…",
    );
    await expect(tools.describe(context(), { name: "load_resource", input: { resource_id: "f1" } })).resolves.toBe(
      "Reading Lab 2 handout…",
    );
  });

  it("falls back to a generic message for an unknown file", async () => {
    const { tools } = build([]);

    await expect(tools.describe(context(), { name: "get_resource", input: { resource_id: "nope" } })).resolves.toBe(
      "Reading course material…",
    );
  });

  it("names the search query", async () => {
    const { tools } = build();

    await expect(
      tools.describe(context(), { name: "search_course_materials", input: { query: "greedy algorithms" } }),
    ).resolves.toBe('Searching course materials for "greedy algorithms"…');
  });
});
