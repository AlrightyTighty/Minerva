import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { ActiveResource, Thread } from "../models/items.js";
import { courseThreadsPrefix, threadSk, userPk } from "../models/keys.js";
import { isConditionalCheckFailed } from "./dynamo-errors.js";
import { queryByPrefix, stripKeys } from "./query-helpers.js";

export interface ThreadRef {
  userId: string;
  courseId: string;
  threadId: string;
}

export class ThreadsRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** Returns false if a thread with that id already exists. */
  async create(thread: Thread): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...this.key(thread), ...thread },
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

  async get(ref: ThreadRef): Promise<Thread | undefined> {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: this.key(ref) }));
    return result.Item ? stripKeys<Thread>(result.Item) : undefined;
  }

  /** Every thread of the course, including soft-deleted ones. */
  async listByCourse(userId: string, courseId: string): Promise<Thread[]> {
    return queryByPrefix<Thread>(this.client, this.tableName, userPk(userId), courseThreadsPrefix(courseId));
  }

  /**
   * Counts a finished turn. Uses ADD, never a read-modify-write, so two quick messages
   * cannot overwrite each other. Returns the new turn count.
   */
  async incrementTurn(ref: ThreadRef): Promise<number> {
    const result = await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: this.key(ref),
        UpdateExpression: "SET updatedAt = :now ADD turnCount :one",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":one": 1, ":now": new Date().toISOString() },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return result.Attributes?.turnCount as number;
  }

  /** Sets one entry of the active-resource map, leaving the others untouched. */
  async setActiveResource(ref: ThreadRef, fileId: string, resource: ActiveResource): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: this.key(ref),
        UpdateExpression: "SET activeResources.#file = :resource",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: { "#file": fileId },
        ExpressionAttributeValues: { ":resource": resource },
      }),
    );
  }

  async removeActiveResources(ref: ThreadRef, fileIds: string[]): Promise<void> {
    if (fileIds.length === 0) {
      return;
    }
    const names: Record<string, string> = {};
    const paths = fileIds.map((fileId, index) => {
      names[`#file${index}`] = fileId;
      return `activeResources.#file${index}`;
    });
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: this.key(ref),
        UpdateExpression: `REMOVE ${paths.join(", ")}`,
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: names,
      }),
    );
  }

  private key(ref: ThreadRef) {
    return { PK: userPk(ref.userId), SK: threadSk(ref.courseId, ref.threadId) };
  }
}
