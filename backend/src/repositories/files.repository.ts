import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { CourseFile, FileRef, FileStatus } from "../models/items.js";
import { courseFilesPrefix, fileSk, userPk } from "../models/keys.js";
import { isConditionalCheckFailed } from "./dynamo-errors.js";
import { queryByPrefix } from "./query-helpers.js";

export type FileUpdate = Partial<Omit<CourseFile, "fileId" | "userId" | "courseId" | "createdAt">>;

export class FilesRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async get(ref: FileRef): Promise<CourseFile | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: this.key(ref),
      }),
    );
    if (!result.Item) {
      return undefined;
    }
    const { PK: _pk, SK: _sk, ...file } = result.Item;
    return file as CourseFile;
  }

  /** Every file in the course, including soft-deleted ones and files that are not ready. */
  async listByCourse(userId: string, courseId: string): Promise<CourseFile[]> {
    return queryByPrefix<CourseFile>(this.client, this.tableName, userPk(userId), courseFilesPrefix(courseId));
  }

  /** Creates the file item. Returns false if one already exists. */
  async create(file: CourseFile): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...this.key(file), ...file },
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

  /**
   * Moves a file to a new status, but only if it is currently in one of the `from` statuses.
   * Returns false when it is not, which is how duplicate events and retries are made harmless.
   */
  async transition(
    ref: FileRef,
    from: FileStatus[],
    to: FileStatus,
    fields: FileUpdate = {},
  ): Promise<boolean> {
    return this.update(ref, { ...fields, status: to }, from);
  }

  /** Updates fields on an existing file. Returns false if the file does not exist (or is not in `onlyIfStatus`). */
  async update(ref: FileRef, fields: FileUpdate, onlyIfStatus?: FileStatus[]): Promise<boolean> {
    const values: Record<string, unknown> = { ...fields, updatedAt: new Date().toISOString() };
    const names: Record<string, string> = {};
    const expressionValues: Record<string, unknown> = {};
    const assignments: string[] = [];

    Object.entries(values).forEach(([field, value], index) => {
      if (value === undefined) {
        return;
      }
      names[`#f${index}`] = field;
      expressionValues[`:v${index}`] = value;
      assignments.push(`#f${index} = :v${index}`);
    });

    let condition = "attribute_exists(PK)";
    if (onlyIfStatus) {
      names["#status"] = "status";
      onlyIfStatus.forEach((status, index) => {
        expressionValues[`:from${index}`] = status;
      });
      condition = `#status IN (${onlyIfStatus.map((_, index) => `:from${index}`).join(", ")})`;
    }

    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(ref),
          UpdateExpression: `SET ${assignments.join(", ")}`,
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: expressionValues,
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

  private key(ref: FileRef) {
    return { PK: userPk(ref.userId), SK: fileSk(ref.courseId, ref.fileId) };
  }
}
