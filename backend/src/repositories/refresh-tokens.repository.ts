import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { RefreshTokenRecord } from "../models/items.js";
import { REFRESH_PREFIX, refreshSk, userPk } from "../models/keys.js";
import { isConditionalCheckFailed } from "./dynamo-errors.js";
import { queryByPrefix, stripKeys } from "./query-helpers.js";

export class RefreshTokensRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** Returns false if a token with that id already exists. */
  async create(record: RefreshTokenRecord): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...this.key(record.userId, record.tokenId), ...record },
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

  async get(userId: string, tokenId: string): Promise<RefreshTokenRecord | undefined> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: this.key(userId, tokenId) }),
    );
    return result.Item ? stripKeys<RefreshTokenRecord>(result.Item) : undefined;
  }

  /**
   * Marks the token used, but only if nobody has used or revoked it. When two refreshes with the same token race,
   * exactly one of them gets true.
   */
  async markUsed(userId: string, tokenId: string, usedAt: string): Promise<boolean> {
    return this.set(
      userId,
      tokenId,
      "SET usedAt = :usedAt",
      "attribute_exists(PK) AND attribute_not_exists(usedAt) AND attribute_not_exists(revokedAt)",
      { ":usedAt": usedAt },
    );
  }

  /** Revokes the token. False if it is gone or already revoked, which keeps the first revocation time. */
  async revoke(userId: string, tokenId: string, revokedAt: string): Promise<boolean> {
    return this.set(
      userId,
      tokenId,
      "SET revokedAt = :revokedAt",
      "attribute_exists(PK) AND attribute_not_exists(revokedAt)",
      { ":revokedAt": revokedAt },
    );
  }

  async listByUser(userId: string): Promise<RefreshTokenRecord[]> {
    return queryByPrefix<RefreshTokenRecord>(this.client, this.tableName, userPk(userId), REFRESH_PREFIX);
  }

  private async set(
    userId: string,
    tokenId: string,
    expression: string,
    condition: string,
    values: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(userId, tokenId),
          UpdateExpression: expression,
          ConditionExpression: condition,
          ExpressionAttributeValues: values,
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

  private key(userId: string, tokenId: string) {
    return { PK: userPk(userId), SK: refreshSk(tokenId) };
  }
}
