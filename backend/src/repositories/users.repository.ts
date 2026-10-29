import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LoginRecord, UserProfile } from "../models/items.js";
import { loginPk, loginSk, profileSk, userPk } from "../models/keys.js";
import { isConditionalCheckFailed } from "./dynamo-errors.js";
import { stripKeys } from "./query-helpers.js";

export class UsersRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /**
   * Creates a user and the login they sign in with, in one transaction, so there is never a user without a way in.
   * The login is only written if its email is new, which is what makes an email unique.
   * Returns false if the email is taken, and throws if the user id is (which a ULID should never allow).
   */
  async createWithLogin(user: UserProfile, login: LoginRecord): Promise<boolean> {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: { PK: userPk(user.userId), SK: profileSk(), ...user },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: { PK: loginPk(login.email), SK: loginSk(), ...login },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
      return true;
    } catch (err) {
      const reasons = (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
      if (err instanceof Error && err.name === "TransactionCanceledException" && reasons) {
        if (reasons[0]?.Code === "ConditionalCheckFailed") {
          throw new Error(`User id collision for ${user.userId}`);
        }
        if (reasons[1]?.Code === "ConditionalCheckFailed") {
          return false;
        }
      }
      throw err;
    }
  }

  /** Sets (or with null, clears) the study preferences. Returns the updated profile, or undefined if there is no such user. */
  async update(userId: string, fields: { studyPreferences?: string | null }): Promise<UserProfile | undefined> {
    if (fields.studyPreferences === undefined) {
      throw new Error("No fields to update");
    }
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: userPk(userId), SK: profileSk() },
          UpdateExpression: "SET studyPreferences = :studyPreferences",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeValues: { ":studyPreferences": fields.studyPreferences },
          ReturnValues: "ALL_NEW",
        }),
      );
      return result.Attributes ? stripKeys<UserProfile>(result.Attributes) : undefined;
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        return undefined;
      }
      throw err;
    }
  }

  async get(userId: string): Promise<UserProfile | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: userPk(userId), SK: profileSk() },
      }),
    );
    return result.Item ? stripKeys<UserProfile>(result.Item) : undefined;
  }
}
