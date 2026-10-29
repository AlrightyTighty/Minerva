import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Assignment } from "../models/items.js";
import { ASSIGNMENT_PREFIX, assignmentSk, courseAssignmentsPrefix, userPk } from "../models/keys.js";
import { isConditionalCheckFailed } from "./dynamo-errors.js";
import { queryByPrefix, stripKeys } from "./query-helpers.js";

export interface AssignmentRef {
  userId: string;
  courseId: string;
  assignmentId: string;
}

/** The fields an assignment can be edited through. Ids, files and the completion and deletion times are not among them. */
export type AssignmentEdit = Partial<Pick<Assignment, "title" | "description" | "dueAt">>;

const EDITABLE_FIELDS = ["title", "description", "dueAt"] as const;

const EXISTS = "attribute_exists(PK)";

/**
 * Stores assignments as they are, soft-deleted ones included. What a deleted assignment means is a business
 * rule, so it is the service's to apply.
 */
export class AssignmentsRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** Returns false if an assignment with that id already exists. */
  async create(assignment: Assignment): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { PK: userPk(assignment.userId), SK: assignmentSk(assignment.courseId, assignment.assignmentId), ...assignment },
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

  async get(ref: AssignmentRef): Promise<Assignment | undefined> {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: this.key(ref) }));
    return result.Item ? stripKeys<Assignment>(result.Item) : undefined;
  }

  async listByCourse(userId: string, courseId: string): Promise<Assignment[]> {
    return queryByPrefix<Assignment>(this.client, this.tableName, userPk(userId), courseAssignmentsPrefix(courseId));
  }

  async listByUser(userId: string): Promise<Assignment[]> {
    return queryByPrefix<Assignment>(this.client, this.tableName, userPk(userId), ASSIGNMENT_PREFIX);
  }

  /** Appends a file id to the assignment. Returns false if the assignment does not exist. */
  async addFile(ref: AssignmentRef, fileId: string): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(ref),
          UpdateExpression: "SET fileIds = list_append(if_not_exists(fileIds, :empty), :file)",
          ConditionExpression: EXISTS,
          ExpressionAttributeValues: { ":empty": [], ":file": [fileId] },
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

  /** Sets (or with null, clears) the completion time. Returns the updated assignment, or undefined if it does not exist. */
  async setCompleted(ref: AssignmentRef, completedAt: string | null): Promise<Assignment | undefined> {
    return this.updateItem(ref, "SET completedAt = :completedAt", undefined, { ":completedAt": completedAt });
  }

  /** Edits the given fields only. Returns the updated assignment, or undefined if it does not exist. */
  async update(ref: AssignmentRef, edit: AssignmentEdit): Promise<Assignment | undefined> {
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const assignments: string[] = [];
    EDITABLE_FIELDS.forEach((field, index) => {
      const value = edit[field];
      if (value === undefined) {
        return;
      }
      names[`#f${index}`] = field;
      values[`:v${index}`] = value;
      assignments.push(`#f${index} = :v${index}`);
    });
    if (assignments.length === 0) {
      throw new Error("No fields to update");
    }
    return this.updateItem(ref, `SET ${assignments.join(", ")}`, names, values);
  }

  /** Marks the assignment deleted. Returns false if it does not exist. */
  async softDelete(ref: AssignmentRef, deletedAt: string): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(ref),
          UpdateExpression: "SET deletedAt = :deletedAt",
          ConditionExpression: EXISTS,
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

  private async updateItem(
    ref: AssignmentRef,
    expression: string,
    names: Record<string, string> | undefined,
    values: Record<string, unknown>,
  ): Promise<Assignment | undefined> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(ref),
          UpdateExpression: expression,
          ConditionExpression: EXISTS,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        }),
      );
      return result.Attributes ? stripKeys<Assignment>(result.Attributes) : undefined;
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        return undefined;
      }
      throw err;
    }
  }

  private key(ref: AssignmentRef) {
    return { PK: userPk(ref.userId), SK: assignmentSk(ref.courseId, ref.assignmentId) };
  }
}
