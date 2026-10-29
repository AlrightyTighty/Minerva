import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

export interface Summarizer {
  summarize(markdown: string): Promise<string>;
}

const SYSTEM_PROMPT =
  "You write catalog summaries of course materials for a study assistant. " +
  "Reply with one or two plain sentences saying what the document is and what it covers. No preamble.";

export class BedrockSummarizer implements Summarizer {
  constructor(
    private readonly client: BedrockRuntimeClient,
    private readonly modelId: string,
  ) {}

  async summarize(markdown: string): Promise<string> {
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: "user", content: [{ text: markdown }] }],
        inferenceConfig: { maxTokens: 200, temperature: 0 },
      }),
    );
    const text = response.output?.message?.content?.map((block) => block.text ?? "").join("").trim();
    if (!text) {
      throw new Error("Summary model returned no text");
    }
    return text;
  }
}
