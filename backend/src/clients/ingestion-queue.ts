import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { IngestionMessage } from "../models/events.js";

export interface IngestionQueue {
  /** `delaySeconds` hides the message from consumers for that long (SQS allows up to 900). */
  send(message: IngestionMessage, delaySeconds?: number): Promise<void>;
}

export class SqsIngestionQueue implements IngestionQueue {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async send(message: IngestionMessage, delaySeconds = 0): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
        DelaySeconds: delaySeconds,
      }),
    );
  }
}
