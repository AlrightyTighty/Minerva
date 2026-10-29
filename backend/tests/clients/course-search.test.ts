import { describe, expect, it, vi } from "vitest";
import type { BedrockAgentRuntimeClient } from "@aws-sdk/client-bedrock-agent-runtime";
import { BedrockCourseSearch } from "../../src/clients/course-search.js";

function build(results: unknown[] = []) {
  const send = vi.fn().mockResolvedValue({ retrievalResults: results });
  const search = new BedrockCourseSearch({ send } as unknown as BedrockAgentRuntimeClient, "kb-123");
  return { search, send, input: () => send.mock.calls[0][0].input };
}

describe("BedrockCourseSearch", () => {
  it("queries the knowledge base", async () => {
    const { search, input } = build();

    await search.retrieve({ query: "greedy algorithms", filter: { userId: "u1", courseId: "c1" }, topK: 6 });

    expect(input().knowledgeBaseId).toBe("kb-123");
    expect(input().retrievalQuery).toEqual({ text: "greedy algorithms" });
    expect(input().retrievalConfiguration.vectorSearchConfiguration.numberOfResults).toBe(6);
  });

  it("always filters on the user and course, and hides soft-deleted files", async () => {
    const { search, input } = build();

    await search.retrieve({ query: "q", filter: { userId: "u1", courseId: "c1" }, topK: 5 });

    expect(input().retrievalConfiguration.vectorSearchConfiguration.filter).toEqual({
      andAll: [
        { equals: { key: "user_id", value: "u1" } },
        { equals: { key: "course_id", value: "c1" } },
        { equals: { key: "deleted", value: false } },
      ],
    });
  });

  it("adds the optional narrowing on top of the required filters, never in place of them", async () => {
    const { search, input } = build();

    await search.retrieve({
      query: "q",
      filter: { userId: "u1", courseId: "c1", fileId: "f1", docType: "textbook" },
      topK: 5,
    });

    expect(input().retrievalConfiguration.vectorSearchConfiguration.filter).toEqual({
      andAll: [
        { equals: { key: "user_id", value: "u1" } },
        { equals: { key: "course_id", value: "c1" } },
        { equals: { key: "deleted", value: false } },
        { equals: { key: "file_id", value: "f1" } },
        { equals: { key: "doc_type", value: "textbook" } },
      ],
    });
  });

  it("returns the passages with the file they came from", async () => {
    const { search } = build([
      {
        content: { text: "Greedy picks the local optimum." },
        score: 0.82,
        metadata: { file_id: "f1", doc_type: "notes", part: 1 },
      },
    ]);

    await expect(search.retrieve({ query: "q", filter: { userId: "u1", courseId: "c1" }, topK: 5 })).resolves.toEqual([
      { text: "Greedy picks the local optimum.", score: 0.82, fileId: "f1", docType: "notes" },
    ]);
  });

  it("drops results that have no text", async () => {
    const { search } = build([{ content: {}, score: 0.9 }, { content: { text: "kept" }, score: 0.5, metadata: {} }]);

    const hits = await search.retrieve({ query: "q", filter: { userId: "u1", courseId: "c1" }, topK: 5 });

    expect(hits.map((hit) => hit.text)).toEqual(["kept"]);
  });

  it("returns nothing when the knowledge base has no results", async () => {
    const { search, send } = build();
    send.mockResolvedValue({});

    await expect(search.retrieve({ query: "q", filter: { userId: "u1", courseId: "c1" }, topK: 5 })).resolves.toEqual([]);
  });
});
