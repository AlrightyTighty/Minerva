import { describe, expect, it, vi } from "vitest";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { BedrockChatModel, type ModelEvent } from "../../src/clients/chat-model.js";

async function* stream(...events: unknown[]) {
  yield* events;
}

function build(...events: unknown[]) {
  const send = vi.fn().mockResolvedValue({ stream: stream(...events) });
  const model = new BedrockChatModel({ send } as unknown as BedrockRuntimeClient, "model-id");
  const collect = async (request: Partial<Parameters<BedrockChatModel["converse"]>[0]> = {}) => {
    const out: ModelEvent[] = [];
    for await (const event of model.converse({ system: "sys", messages: [], tools: [], ...request })) out.push(event);
    return out;
  };
  return { model, send, collect, input: () => send.mock.calls[0][0].input };
}

describe("BedrockChatModel request", () => {
  it("sends the model id, system prompt and output limit", async () => {
    const { collect, input } = build();

    await collect({ system: "You are a tutor." });

    expect(input().modelId).toBe("model-id");
    expect(input().system).toEqual([{ text: "You are a tutor." }]);
    expect(input().inferenceConfig.maxTokens).toBeGreaterThan(0);
  });

  it("converts messages: text, images, tool calls and tool results", async () => {
    const { collect, input } = build();
    const bytes = new Uint8Array([1, 2]);

    await collect({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", format: "png", bytes },
            { type: "text", text: "what is this?" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", toolUseId: "tu1", name: "get_resource", input: { resource_id: "f1" } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "tu1", text: "file text", isError: false },
            { type: "tool_result", toolUseId: "tu2", text: "nope", isError: true },
          ],
        },
      ],
    });

    expect(input().messages).toEqual([
      {
        role: "user",
        content: [{ image: { format: "png", source: { bytes } } }, { text: "what is this?" }],
      },
      {
        role: "assistant",
        content: [{ toolUse: { toolUseId: "tu1", name: "get_resource", input: { resource_id: "f1" } } }],
      },
      {
        role: "user",
        content: [
          { toolResult: { toolUseId: "tu1", content: [{ text: "file text" }], status: "success" } },
          { toolResult: { toolUseId: "tu2", content: [{ text: "nope" }], status: "error" } },
        ],
      },
    ]);
  });

  it("describes the tools to the model", async () => {
    const { collect, input } = build();

    await collect({ tools: [{ name: "get_resource", description: "Reads a file.", inputSchema: { type: "object" } }] });

    expect(input().toolConfig).toEqual({
      tools: [
        {
          toolSpec: { name: "get_resource", description: "Reads a file.", inputSchema: { json: { type: "object" } } },
        },
      ],
    });
  });

  it("leaves out the tool configuration when there are no tools, which is how tool use is switched off", async () => {
    const { collect, input } = build();

    await collect({ tools: [] });

    expect(input().toolConfig).toBeUndefined();
  });
});

describe("BedrockChatModel stream", () => {
  it("turns text deltas into text events and ends with the stop reason", async () => {
    const { collect } = build(
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hel" } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "lo" } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
    );

    await expect(collect()).resolves.toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "stop", reason: "end_turn" },
    ]);
  });

  it("assembles a tool call from its streamed JSON, emitting it once complete", async () => {
    const { collect } = build(
      { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "tu1", name: "search_course_materials" } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"query":' } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '"greedy"}' } } } },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: "tool_use" } },
    );

    await expect(collect()).resolves.toEqual([
      { type: "tool_use", toolUseId: "tu1", name: "search_course_materials", input: { query: "greedy" } },
      { type: "stop", reason: "tool_use" },
    ]);
  });

  it("treats a tool call with no input as an empty object", async () => {
    const { collect } = build(
      { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "tu1", name: "get_resource" } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "tool_use" } },
    );

    await expect(collect()).resolves.toContainEqual({ type: "tool_use", toolUseId: "tu1", name: "get_resource", input: {} });
  });

  it("keeps text and tool calls apart when they are interleaved", async () => {
    const { collect } = build(
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Checking. " } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "tu1", name: "get_resource" } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"resource_id":"f1"}' } } } },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: "tool_use" } },
    );

    await expect(collect()).resolves.toEqual([
      { type: "text", text: "Checking. " },
      { type: "tool_use", toolUseId: "tu1", name: "get_resource", input: { resource_id: "f1" } },
      { type: "stop", reason: "tool_use" },
    ]);
  });

  it("fails when a tool call's input is not valid JSON, instead of running it with a guess", async () => {
    const { collect } = build(
      { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "tu1", name: "get_resource" } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"resource_id":' } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
    );

    await expect(collect()).rejects.toThrow();
  });

  it("fails when Bedrock returns no stream", async () => {
    const { send, collect } = build();
    send.mockResolvedValue({});

    await expect(collect()).rejects.toThrow();
  });
});
