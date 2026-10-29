import { describe, expect, it } from "vitest";
import { HYDRATION_BUDGET_TOKENS, planHydration } from "../../src/chat/hydration.js";
import type { CourseFile } from "../../src/models/items.js";

// ids sort in creation order, which is the order hydrated files are listed in (keeps the prompt prefix stable for caching)
const file = (fileId: string, overrides: Partial<CourseFile> = {}): CourseFile =>
  ({
    fileId,
    userId: "u1",
    courseId: "c1",
    title: `File ${fileId}`,
    docType: "notes",
    status: "ready",
    tokenCount: 1000,
    searchOnly: false,
    ...overrides,
  }) as CourseFile;

const thread = (overrides: Partial<{ pinnedResourceIds: string[]; activeResources: Record<string, any> }> = {}) => ({
  pinnedResourceIds: [],
  activeResources: {},
  ...overrides,
});

const plan = (input: Partial<Parameters<typeof planHydration>[0]> & { files: CourseFile[] }) =>
  planHydration({ attachmentIds: [], thread: thread(), turn: 3, ...input });

const ids = (files: CourseFile[]) => files.map((f) => f.fileId);

describe("planHydration", () => {
  it("hydrates nothing when nothing is attached, pinned or active", () => {
    expect(plan({ files: [file("f1")] })).toEqual({ documents: [], images: [] });
  });

  it("always hydrates the files attached to the message, even over the budget", () => {
    const big = file("f1", { tokenCount: HYDRATION_BUDGET_TOKENS * 3 });

    expect(ids(plan({ files: [big], attachmentIds: ["f1"] }).documents)).toEqual(["f1"]);
  });

  it("hydrates pinned files when they fit", () => {
    const result = plan({ files: [file("f1")], thread: thread({ pinnedResourceIds: ["f1"] }) });
    expect(ids(result.documents)).toEqual(["f1"]);
  });

  it("skips a pinned file that does not fit in what is left of the budget", () => {
    const files = [file("f1", { tokenCount: HYDRATION_BUDGET_TOKENS - 500 }), file("f2", { tokenCount: 1000 })];

    const result = plan({ files, attachmentIds: ["f1"], thread: thread({ pinnedResourceIds: ["f2"] }) });

    expect(ids(result.documents)).toEqual(["f1"]);
  });

  it("skips a pinned file whose size is unknown", () => {
    const result = plan({
      files: [file("f1", { tokenCount: undefined })],
      thread: thread({ pinnedResourceIds: ["f1"] }),
    });
    expect(result.documents).toEqual([]);
  });

  it("hydrates unexpired active resources, and not expired ones", () => {
    const active = {
      f1: { loadedAtTurn: 1, expiresAfterTurn: 3 }, // last turn it is included is turn 3
      f2: { loadedAtTurn: 1, expiresAfterTurn: 2 },
    };

    const result = plan({ files: [file("f1"), file("f2")], thread: thread({ activeResources: active }), turn: 3 });

    expect(ids(result.documents)).toEqual(["f1"]);
  });

  it("spends the budget in priority order: attachments, then pinned, then active", () => {
    const files = [
      file("f1", { tokenCount: 8000 }), // active
      file("f2", { tokenCount: 8000 }), // pinned
      file("f3", { tokenCount: 8000 }), // attached
    ];

    const result = plan({
      files,
      attachmentIds: ["f3"],
      thread: thread({ pinnedResourceIds: ["f2"], activeResources: { f1: { loadedAtTurn: 1, expiresAfterTurn: 9 } } }),
    });

    // 8000 + 8000 fits in 20000, the third 8000 does not, and the active file is the lowest priority
    expect(ids(result.documents)).toEqual(["f2", "f3"]);
  });

  it("lists hydrated files in a stable order, whichever way they were selected", () => {
    const files = [file("f3"), file("f1"), file("f2")];

    const result = plan({
      files,
      attachmentIds: ["f3"],
      thread: thread({ pinnedResourceIds: ["f1"], activeResources: { f2: { loadedAtTurn: 1, expiresAfterTurn: 9 } } }),
    });

    expect(ids(result.documents)).toEqual(["f1", "f2", "f3"]);
  });

  it("includes a file once when it is attached, pinned and active", () => {
    const result = plan({
      files: [file("f1")],
      attachmentIds: ["f1"],
      thread: thread({ pinnedResourceIds: ["f1"], activeResources: { f1: { loadedAtTurn: 1, expiresAfterTurn: 9 } } }),
    });

    expect(ids(result.documents)).toEqual(["f1"]);
  });

  it("never hydrates search-only files, not even when attached or pinned", () => {
    const textbook = file("f1", { docType: "textbook", searchOnly: true, tokenCount: 90_000 });

    const result = plan({
      files: [textbook],
      attachmentIds: ["f1"],
      thread: thread({ pinnedResourceIds: ["f1"], activeResources: { f1: { loadedAtTurn: 1, expiresAfterTurn: 9 } } }),
    });

    expect(result).toEqual({ documents: [], images: [] });
  });

  it.each([
    ["not ready", { status: "parsing" as const }],
    ["failed", { status: "failed" as const }],
    ["soft-deleted", { deletedAt: "2026-10-20T00:00:00.000Z" }],
  ])("never hydrates a file that is %s", (_label, overrides) => {
    const result = plan({
      files: [file("f1", overrides)],
      attachmentIds: ["f1"],
      thread: thread({ pinnedResourceIds: ["f1"] }),
    });

    expect(result).toEqual({ documents: [], images: [] });
  });

  it("ignores ids that are not in the course", () => {
    const result = plan({ files: [], attachmentIds: ["nope"], thread: thread({ pinnedResourceIds: ["nope"] }) });
    expect(result).toEqual({ documents: [], images: [] });
  });

  describe("images", () => {
    const image = (fileId: string) => file(fileId, { docType: "image", tokenCount: undefined });

    it("includes an image attached to this message", () => {
      const result = plan({ files: [image("f1")], attachmentIds: ["f1"] });
      expect(ids(result.images)).toEqual(["f1"]);
      expect(result.documents).toEqual([]);
    });

    it("includes a pinned image", () => {
      const result = plan({ files: [image("f1")], thread: thread({ pinnedResourceIds: ["f1"] }) });
      expect(ids(result.images)).toEqual(["f1"]);
    });

    it("does not include an image from an earlier turn just because it is still active", () => {
      const result = plan({
        files: [image("f1")],
        thread: thread({ activeResources: { f1: { loadedAtTurn: 1, expiresAfterTurn: 9 } } }),
      });
      expect(result.images).toEqual([]);
    });

    it("does not count images against the document budget", () => {
      const files = [image("f1"), file("f2", { tokenCount: HYDRATION_BUDGET_TOKENS })];

      const result = plan({ files, attachmentIds: ["f1"], thread: thread({ pinnedResourceIds: ["f2"] }) });

      expect(ids(result.documents)).toEqual(["f2"]);
      expect(ids(result.images)).toEqual(["f1"]);
    });
  });
});
