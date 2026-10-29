import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LoginRecord } from "../models/items.js";
import { loginPk, loginSk } from "../models/keys.js";
import { isConditionalCheckFailed } from "./dynamo-errors.js";
import { stripKeys } from "./query-helpers.js";

/** Reads and updates logins. They are created together with their user, by UsersRepository.createWithLogin. */
export class LoginsRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async get(email: string): Promise<LoginRecord | undefined> {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: this.key(email) }));
    return result.Item ? stripKeys<LoginRecord>(result.Item) : undefined;
  }

  /** Counts a wrong password, atomically, and returns the new count. 0 if there is no such login. */
  async recordFailure(email: string): Promise<number> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(email),
          UpdateExpression: "ADD failedAttempts :one",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeValues: { ":one": 1 },
          ReturnValues: "UPDATED_NEW",
        }),
      );
      return (result.Attributes?.failedAttempts as number | undefined) ?? 0;
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        return 0;
      }
      throw err;
    }
  }

  /** Locks the account until the given time, and starts the count again for when it opens. */
  async lock(email: string, lockedUntil: string): Promise<void> {
    await this.update(email, "SET lockedUntil = :until, failedAttempts = :zero", { ":until": lockedUntil, ":zero": 0 });
  }

  async clearFailures(email: string): Promise<void> {
    await this.update(email, "SET failedAttempts = :zero REMOVE lockedUntil", { ":zero": 0 });
  }

  async setPasswordHash(email: string, passwordHash: string): Promise<void> {
    await this.update(email, "SET passwordHash = :hash", { ":hash": passwordHash });
  }

  private async update(email: string, expression: string, values: Record<string, unknown>): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(email),
          UpdateExpression: expression,
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeValues: values,
        }),
      );
    } catch (err) {
      // a login that has gone has nothing left to update
      if (!isConditionalCheckFailed(err)) {
        throw err;
      }
    }
  }

  private key(email: string) {
    return { PK: loginPk(email), SK: loginSk() };
  }
}
