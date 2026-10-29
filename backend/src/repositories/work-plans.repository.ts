import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { WorkPlan } from "../models/items.js";
import { WORKPLAN_PREFIX, userPk, workPlanSk } from "../models/keys.js";
import { isConditionalCheckFailed } from "./dynamo-errors.js";
import { queryByPrefix, stripKeys } from "./query-helpers.js";

export interface ItemCompletion {
  /** Where the item sits in the plan's list. */
  index: number;
  /** The write only happens if this is still the item at that position. */
  itemId: string;
  completedAt: string | null;
}

/**
 * Stores work plans as they are, soft-deleted ones included. What a deleted plan means is a business rule,
 * so it is the service's to apply.
 */
export class WorkPlansRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** Returns false if a plan with that id already exists. */
  async create(plan: WorkPlan): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { PK: userPk(plan.userId), SK: workPlanSk(plan.workPlanId), ...plan },
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

  async get(userId: string, workPlanId: string): Promise<WorkPlan | undefined> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: this.key(userId, workPlanId) }),
    );
    return result.Item ? stripKeys<WorkPlan>(result.Item) : undefined;
  }

  async listByUser(userId: string): Promise<WorkPlan[]> {
    return queryByPrefix<WorkPlan>(this.client, this.tableName, userPk(userId), WORKPLAN_PREFIX);
  }

  /**
   * Sets (or with null, clears) the completion time of items, in one write. Each change is guarded by the item's
   * id, so if the list has changed under the caller nothing is written. Returns false in that case, or if the
   * plan does not exist.
   */
  async setItemsCompleted(userId: string, workPlanId: string, changes: ItemCompletion[]): Promise<boolean> {
    if (changes.length === 0) {
      return true;
    }
    const assignments: string[] = [];
    const conditions = ["attribute_exists(PK)"];
    const values: Record<string, unknown> = {};
    changes.forEach(({ index, itemId, completedAt }, position) => {
      // the position is part of the expression text and cannot be a placeholder, so it must be a plain number
      if (!Number.isInteger(index) || index < 0) {
        throw new Error(`Invalid item position ${index}`);
      }
      // "items" is a DynamoDB reserved word, so it can only be used through an expression attribute name
      assignments.push(`#items[${index}].completedAt = :c${position}`);
      conditions.push(`#items[${index}].itemId = :id${position}`);
      values[`:c${position}`] = completedAt;
      values[`:id${position}`] = itemId;
    });

    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(userId, workPlanId),
          UpdateExpression: `SET ${assignments.join(", ")}`,
          ConditionExpression: conditions.join(" AND "),
          ExpressionAttributeNames: { "#items": "items" },
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

  /** Marks the plan deleted. Returns false if it does not exist. */
  async softDelete(userId: string, workPlanId: string, deletedAt: string): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(userId, workPlanId),
          UpdateExpression: "SET deletedAt = :deletedAt",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeValues: { ":deletedAt": deletedAt },
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

  private key(userId: string, workPlanId: string) {
    return { PK: userPk(userId), SK: workPlanSk(workPlanId) };
  }
}
