import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Course } from "../models/items.js";
import { COURSE_PREFIX, courseSk, userPk } from "../models/keys.js";
import { isConditionalCheckFailed } from "./dynamo-errors.js";
import { queryByPrefix, stripKeys } from "./query-helpers.js";

export class CoursesRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** Returns false if a course with that id already exists for the user. */
  async create(course: Course): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { PK: userPk(course.userId), SK: courseSk(course.courseId), ...course },
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

  async get(userId: string, courseId: string): Promise<Course | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: userPk(userId), SK: courseSk(courseId) },
      }),
    );
    return result.Item ? stripKeys<Course>(result.Item) : undefined;
  }

  /** Every course of the user, including soft-deleted ones. */
  async listByUser(userId: string): Promise<Course[]> {
    return queryByPrefix<Course>(this.client, this.tableName, userPk(userId), COURSE_PREFIX);
  }
}
