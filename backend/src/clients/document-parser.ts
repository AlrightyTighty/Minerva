import { InvokeDataAutomationAsyncCommand } from "@aws-sdk/client-bedrock-data-automation-runtime";
import type { BedrockDataAutomationRuntimeClient } from "@aws-sdk/client-bedrock-data-automation-runtime";

export interface StartParseInput {
  inputUri: string;
  outputUri: string;
  /** Same token means same job, so a retried call cannot start a second billed job. */
  clientToken: string;
}

export interface DocumentParser {
  /** Starts an async parse and returns its invocation ARN. */
  start(input: StartParseInput): Promise<string>;
}

export class BdaDocumentParser implements DocumentParser {
  constructor(
    private readonly client: BedrockDataAutomationRuntimeClient,
    private readonly projectArn: string,
    private readonly profileArn: string,
  ) {}

  async start(input: StartParseInput): Promise<string> {
    const response = await this.client.send(
      new InvokeDataAutomationAsyncCommand({
        inputConfiguration: { s3Uri: input.inputUri },
        outputConfiguration: { s3Uri: input.outputUri },
        dataAutomationConfiguration: { dataAutomationProjectArn: this.projectArn, stage: "LIVE" },
        dataAutomationProfileArn: this.profileArn,
        // without this BDA never publishes its completion event, so post-process would never run
        notificationConfiguration: { eventBridgeConfiguration: { eventBridgeEnabled: true } },
        clientToken: input.clientToken,
      }),
    );
    if (!response.invocationArn) {
      throw new Error("BDA did not return an invocation ARN");
    }
    return response.invocationArn;
  }
}
