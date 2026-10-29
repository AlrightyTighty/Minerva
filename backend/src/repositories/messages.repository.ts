import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Message } from "../models/items.js";
import { MESSAGE_PREFIX, messageSk, threadPk } from "../models/keys.js";
import { isConditionalCheckFailed } from "./dynamo-errors.js";
import { stripKeys } from "./query-helpers.js";

export class MessagesRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** Returns false if a message with that id already exists in the thread. */
  async put(threadId: string, message: Message): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { PK: threadPk(threadId), SK: messageSk(message.messageId), ...message },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        return false;
      }
      throw err;
    }
  }

  /** The newest `limit` messages, oldest first. The caller must already have checked the user owns the thread. */
  async listRecent(threadId: string, limit: number): Promise<Message[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": threadPk(threadId), ":prefix": MESSAGE_PREFIX },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (response.Items ?? []).map((item) => stripKeys<Message>(item)).reverse();
  }
}
