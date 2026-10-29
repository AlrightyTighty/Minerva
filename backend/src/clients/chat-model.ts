import { ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import type { BedrockRuntimeClient, ContentBlock, ImageFormat, Message } from "@aws-sdk/client-bedrock-runtime";

export type ImageBlockFormat = "png" | "jpeg" | "gif" | "webp";

export type ModelContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; format: ImageBlockFormat; bytes: Uint8Array }
  | { type: "tool_use"; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; text: string; isError?: boolean };

export interface ModelMessage {
  role: "user" | "assistant";
  content: ModelContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ModelEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: "stop"; reason: "end_turn" | "tool_use" | "max_tokens" };

export interface ConverseRequest {
  system: string;
  messages: ModelMessage[];
  /** Leaving this empty switches tool use off. */
  tools: ToolSpec[];
}

export interface ChatModel {
  converse(request: ConverseRequest): AsyncIterable<ModelEvent>;
}

const MAX_OUTPUT_TOKENS = 4096;

function toBedrockBlock(block: ModelContentBlock): ContentBlock {
  switch (block.type) {
    case "text":
      return { text: block.text };
    case "image":
      return { image: { format: block.format as ImageFormat, source: { bytes: block.bytes } } };
    case "tool_use":
      return { toolUse: { toolUseId: block.toolUseId, name: block.name, input: block.input as never } };
    case "tool_result":
      return {
        toolResult: {
          toolUseId: block.toolUseId,
          content: [{ text: block.text }],
          status: block.isError ? "error" : "success",
        },
      };
  }
}

const toBedrockMessage = (message: ModelMessage): Message => ({
  role: message.role,
  content: message.content.map(toBedrockBlock),
});

interface PendingToolCall {
  toolUseId: string;
  name: string;
  json: string;
}

export class BedrockChatModel implements ChatModel {
  constructor(
    private readonly client: BedrockRuntimeClient,
    private readonly modelId: string,
  ) {}

  async *converse(request: ConverseRequest): AsyncIterable<ModelEvent> {
    const response = await this.client.send(
      new ConverseStreamCommand({
        modelId: this.modelId,
        system: [{ text: request.system }],
        messages: request.messages.map(toBedrockMessage),
        inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS },
        ...(request.tools.length > 0
          ? {
              toolConfig: {
                tools: request.tools.map((tool) => ({
                  toolSpec: {
                    name: tool.name,
                    description: tool.description,
                    inputSchema: { json: tool.inputSchema as never },
                  },
                })),
              },
            }
          : {}),
      }),
    );
    if (!response.stream) {
      throw new Error("Bedrock returned no stream");
    }

    // a tool call arrives as a start event, then its JSON input in pieces, then a stop event
    const pending = new Map<number, PendingToolCall>();

    for await (const event of response.stream) {
      if (event.contentBlockStart?.start?.toolUse) {
        const { toolUseId, name } = event.contentBlockStart.start.toolUse;
        pending.set(event.contentBlockStart.contentBlockIndex ?? 0, {
          toolUseId: toolUseId ?? "",
          name: name ?? "",
          json: "",
        });
      } else if (event.contentBlockDelta) {
        const { delta, contentBlockIndex } = event.contentBlockDelta;
        if (delta?.text) {
          yield { type: "text", text: delta.text };
        } else if (delta?.toolUse?.input) {
          const call = pending.get(contentBlockIndex ?? 0);
          if (call) {
            call.json += delta.toolUse.input;
          }
        }
      } else if (event.contentBlockStop) {
        const index = event.contentBlockStop.contentBlockIndex ?? 0;
        const call = pending.get(index);
        if (call) {
          pending.delete(index);
          // invalid JSON fails the turn, because running a tool on a guessed input is worse than failing
          const input = call.json ? (JSON.parse(call.json) as Record<string, unknown>) : {};
          yield { type: "tool_use", toolUseId: call.toolUseId, name: call.name, input };
        }
      } else if (event.messageStop) {
        const reason = event.messageStop.stopReason;
        yield { type: "stop", reason: reason === "tool_use" || reason === "max_tokens" ? reason : "end_turn" };
      }
    }
  }
}
