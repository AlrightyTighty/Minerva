import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { CoursesRepository } from "../../src/repositories/courses.repository.js";

const course = { courseId: "c1", userId: "u1", name: "Algorithms", createdAt: "2026-10-26T00:00:00.000Z" };

function createRepository(send: ReturnType<typeof vi.fn>) {
  return new CoursesRepository({ send } as unknown as DynamoDBDocumentClient, "table");
}

describe("CoursesRepository", () => {
  it("stores the course under the user's partition, never overwriting one", async () => {
    const send = vi.fn().mockResolvedValue({});

    await expect(createRepository(send).create(course)).resolves.toBe(true);

    const input = send.mock.calls[0][0].input;
    expect(input.Item).toEqual({ PK: "USER#u1", SK: "COURSE#c1", ...course });
    expect(input.ConditionExpression).toBe("attribute_not_exists(PK)");
  });

  it("reads one course by user and course id, without the key attributes", async () => {
    const send = vi.fn().mockResolvedValue({ Item: { PK: "USER#u1", SK: "COURSE#c1", ...course } });

    await expect(createRepository(send).get("u1", "c1")).resolves.toEqual(course);
    expect(send.mock.calls[0][0].input.Key).toEqual({ PK: "USER#u1", SK: "COURSE#c1" });
  });

  it("returns undefined for a missing course", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(createRepository(send).get("u1", "c9")).resolves.toBeUndefined();
  });

  it("lists a user's courses with one query on the COURSE# prefix", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [{ PK: "USER#u1", SK: "COURSE#c1", ...course }] });

    const result = await createRepository(send).listByUser("u1");

    expect(result).toEqual([course]);
    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0][0].input;
    expect(input.KeyConditionExpression).toBe("PK = :pk AND begins_with(SK, :prefix)");
    expect(input.ExpressionAttributeValues).toEqual({ ":pk": "USER#u1", ":prefix": "COURSE#" });
  });

  it("follows pagination until the query is exhausted", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [{ ...course, courseId: "c1" }], LastEvaluatedKey: { PK: "k" } })
      .mockResolvedValueOnce({ Items: [{ ...course, courseId: "c2" }] });

    const result = await createRepository(send).listByUser("u1");

    expect(result.map((c) => c.courseId)).toEqual(["c1", "c2"]);
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ PK: "k" });
  });
});
