import { InvokeCommand } from "@aws-sdk/client-lambda";
import type { LambdaClient } from "@aws-sdk/client-lambda";
import type { ReuseProcessedEvent } from "../models/events.js";

export interface PostProcessInvoker {
  invokeReuse(event: ReuseProcessedEvent): Promise<void>;
}

export class LambdaPostProcessInvoker implements PostProcessInvoker {
  constructor(
    private readonly client: LambdaClient,
    private readonly functionName: string,
  ) {}

  async invokeReuse(event: ReuseProcessedEvent): Promise<void> {
    await this.client.send(
      new InvokeCommand({
        FunctionName: this.functionName,
        // fire and forget: post-process updates the file's status itself
        InvocationType: "Event",
        Payload: JSON.stringify(event),
      }),
    );
  }
}
