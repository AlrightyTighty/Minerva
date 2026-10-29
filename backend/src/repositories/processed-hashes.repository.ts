import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { FileRef, ProcessedHash } from "../models/items.js";
import { hashPk, hashSk } from "../models/keys.js";
import { isConditionalCheckFailed } from "./dynamo-errors.js";

/** A claim that is never completed (crashed Lambda, BDA job that never reports) expires after this long. */
export const PARSING_CLAIM_TTL_SECONDS = 24 * 60 * 60;

export class ProcessedHashesRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async get(contentHash: string): Promise<ProcessedHash | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: this.key(contentHash),
      }),
    );
    if (!result.Item) {
      return undefined;
    }
    const { PK: _pk, SK: _sk, ...record } = result.Item;
    return record as ProcessedHash;
  }

  /**
   * Claims the right to run BDA for this content. Exactly one caller gets `true`, so a retry
   * or a second upload of the same file can never start a second billed job.
   */
  async claim(contentHash: string): Promise<boolean> {
    const now = new Date();
    const record: ProcessedHash = {
      contentHash,
      status: "parsing",
      waiters: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ttl: Math.floor(now.getTime() / 1000) + PARSING_CLAIM_TTL_SECONDS,
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...this.key(contentHash), ...record },
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

  /** Registers a file to be finished when the claimed parse completes. False if it already completed. */
  async addWaiter(contentHash: string, waiter: FileRef): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(contentHash),
          UpdateExpression: "SET waiters = list_append(waiters, :waiter), updatedAt = :now",
          ConditionExpression: "#status = :parsing",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":waiter": [waiter],
            ":parsing": "parsing",
            ":now": new Date().toISOString(),
          },
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

  /** Marks the parse complete and returns the files that were waiting on it. */
  async complete(
    contentHash: string,
    result: { markdownKey: string; pageCount?: number },
  ): Promise<FileRef[]> {
    try {
      const response = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(contentHash),
          UpdateExpression:
            "SET #status = :complete, markdownKey = :markdownKey, pageCount = :pageCount, updatedAt = :now REMOVE #ttl",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeNames: { "#status": "status", "#ttl": "ttl" },
          ExpressionAttributeValues: {
            ":complete": "complete",
            ":markdownKey": result.markdownKey,
            ":pageCount": result.pageCount ?? null,
            ":now": new Date().toISOString(),
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return (response.Attributes?.waiters as FileRef[] | undefined) ?? [];
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        return [];
      }
      throw err;
    }
  }

  /** Drops a claim after a failed parse so the content can be uploaded again. Returns the waiting files. */
  async release(contentHash: string): Promise<FileRef[]> {
    const response = await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: this.key(contentHash),
        ReturnValues: "ALL_OLD",
      }),
    );
    return (response.Attributes?.waiters as FileRef[] | undefined) ?? [];
  }

  private key(contentHash: string) {
    return { PK: hashPk(contentHash), SK: hashSk() };
  }
}
