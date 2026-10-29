import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Assignment } from "../../src/models/items.js";
import { AssignmentsRepository } from "../../src/repositories/assignments.repository.js";

const ref = { userId: "u1", courseId: "c1", assignmentId: "a1" };

const assignment: Assignment = {
  assignmentId: "a1",
  courseId: "c1",
  userId: "u1",
  title: "Lab 2",
  description: "Greedy lab",
  dueAt: "2026-11-01T22:00:00.000Z",
  fileIds: [],
  completedAt: null,
  createdAt: "2026-10-26T00:00:00.000Z",
};

// every change requires the assignment to exist. Whether a soft-deleted one counts is for the service to decide.
const EXISTS_CONDITION = "attribute_exists(PK)";

const conditionalCheckFailed = () => Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });

function createRepository(send: ReturnType<typeof vi.fn>) {
  return new AssignmentsRepository({ send } as unknown as DynamoDBDocumentClient, "table");
}

describe("AssignmentsRepository", () => {
  it("stores an assignment under the user's partition, never overwriting one", async () => {
    const send = vi.fn().mockResolvedValue({});

    await expect(createRepository(send).create(assignment)).resolves.toBe(true);

    const input = send.mock.calls[0][0].input;
    expect(input.Item).toEqual({ PK: "USER#u1", SK: "ASSIGNMENT#c1#a1", ...assignment });
    expect(input.ConditionExpression).toBe("attribute_not_exists(PK)");
  });

  it("reports false when the assignment id already exists", async () => {
    const send = vi.fn().mockRejectedValue(conditionalCheckFailed());
    await expect(createRepository(send).create(assignment)).resolves.toBe(false);
  });

  it("reads one assignment by user, course and assignment id, without the key attributes", async () => {
    const send = vi.fn().mockResolvedValue({ Item: { PK: "USER#u1", SK: "ASSIGNMENT#c1#a1", ...assignment } });

    await expect(createRepository(send).get(ref)).resolves.toEqual(assignment);
    expect(send.mock.calls[0][0].input.Key).toEqual({ PK: "USER#u1", SK: "ASSIGNMENT#c1#a1" });
  });

  it("returns undefined for a missing assignment", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(createRepository(send).get(ref)).resolves.toBeUndefined();
  });

  it("lists a course's assignments with one query on the ASSIGNMENT#<courseId># prefix", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [{ PK: "USER#u1", SK: "ASSIGNMENT#c1#a1", ...assignment }] });

    await expect(createRepository(send).listByCourse("u1", "c1")).resolves.toEqual([assignment]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues).toEqual({
      ":pk": "USER#u1",
      ":prefix": "ASSIGNMENT#c1#",
    });
  });

  it("lists all of a user's assignments, across courses, with one query on the ASSIGNMENT# prefix", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        { PK: "USER#u1", SK: "ASSIGNMENT#c1#a1", ...assignment },
        { PK: "USER#u1", SK: "ASSIGNMENT#c2#a2", ...assignment, assignmentId: "a2", courseId: "c2" },
      ],
    });

    const result = await createRepository(send).listByUser("u1");

    expect(result.map((a) => a.assignmentId)).toEqual(["a1", "a2"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues).toEqual({ ":pk": "USER#u1", ":prefix": "ASSIGNMENT#" });
  });

  describe("addFile", () => {
    it("appends to the file list atomically, creating the list if there is none", async () => {
      const send = vi.fn().mockResolvedValue({});

      await expect(createRepository(send).addFile(ref, "f1")).resolves.toBe(true);

      const input = send.mock.calls[0][0].input;
      expect(input.Key).toEqual({ PK: "USER#u1", SK: "ASSIGNMENT#c1#a1" });
      expect(input.UpdateExpression).toBe("SET fileIds = list_append(if_not_exists(fileIds, :empty), :file)");
      expect(input.ExpressionAttributeValues).toEqual({ ":empty": [], ":file": ["f1"] });
    });

    it("never creates an assignment that does not exist, and reports false", async () => {
      const send = vi.fn().mockRejectedValue(conditionalCheckFailed());

      await expect(createRepository(send).addFile(ref, "f1")).resolves.toBe(false);

      expect(send).toHaveBeenCalledTimes(1);
    });

    it("only changes an assignment that exists", async () => {
      const send = vi.fn().mockResolvedValue({});

      await createRepository(send).addFile(ref, "f1");

      expect(send.mock.calls[0][0].input.ConditionExpression).toBe(EXISTS_CONDITION);
    });
  });

  describe("setCompleted", () => {
    it("sets the completion time and returns the updated assignment", async () => {
      const completed = { ...assignment, completedAt: "2026-10-27T00:00:00.000Z" };
      const send = vi.fn().mockResolvedValue({ Attributes: { PK: "USER#u1", SK: "ASSIGNMENT#c1#a1", ...completed } });

      const result = await createRepository(send).setCompleted(ref, "2026-10-27T00:00:00.000Z");

      expect(result).toEqual(completed);
      const input = send.mock.calls[0][0].input;
      expect(input.UpdateExpression).toBe("SET completedAt = :completedAt");
      expect(input.ExpressionAttributeValues).toEqual({ ":completedAt": "2026-10-27T00:00:00.000Z" });
      expect(input.ReturnValues).toBe("ALL_NEW");
    });

    it("clears the completion time with null", async () => {
      const send = vi.fn().mockResolvedValue({ Attributes: { ...assignment } });

      await createRepository(send).setCompleted(ref, null);

      expect(send.mock.calls[0][0].input.ExpressionAttributeValues).toEqual({ ":completedAt": null });
    });

    it("never creates an assignment, and returns undefined when it does not exist", async () => {
      const send = vi.fn().mockRejectedValue(conditionalCheckFailed());

      await expect(createRepository(send).setCompleted(ref, "2026-10-27T00:00:00.000Z")).resolves.toBeUndefined();
      expect(send.mock.calls[0][0].input.ConditionExpression).toBe(EXISTS_CONDITION);
    });
  });

  describe("update", () => {
    it("sets only the fields given, and returns the updated assignment", async () => {
      const updated = { ...assignment, title: "Lab 3", dueAt: "2026-11-08T22:00:00.000Z" };
      const send = vi.fn().mockResolvedValue({ Attributes: { PK: "USER#u1", SK: "ASSIGNMENT#c1#a1", ...updated } });

      const result = await createRepository(send).update(ref, { title: "Lab 3", dueAt: "2026-11-08T22:00:00.000Z" });

      expect(result).toEqual(updated);
      const input = send.mock.calls[0][0].input;
      expect(input.Key).toEqual({ PK: "USER#u1", SK: "ASSIGNMENT#c1#a1" });
      expect(input.UpdateExpression).toMatch(/^SET /);
      expect(Object.values(input.ExpressionAttributeNames).sort()).toEqual(["dueAt", "title"]);
      expect(Object.values(input.ExpressionAttributeValues).sort()).toEqual(["2026-11-08T22:00:00.000Z", "Lab 3"]);
      expect(input.ReturnValues).toBe("ALL_NEW");
    });

    it("can clear the description", async () => {
      const send = vi.fn().mockResolvedValue({ Attributes: { ...assignment, description: "" } });

      await createRepository(send).update(ref, { description: "" });

      expect(Object.values(send.mock.calls[0][0].input.ExpressionAttributeValues)).toEqual([""]);
    });

    it("skips fields that are undefined", async () => {
      const send = vi.fn().mockResolvedValue({ Attributes: { ...assignment } });

      await createRepository(send).update(ref, { title: "Lab 3", description: undefined });

      expect(Object.values(send.mock.calls[0][0].input.ExpressionAttributeNames)).toEqual(["title"]);
    });

    it("cannot change the ids, the files, the completion time or the deletion time", async () => {
      const send = vi.fn().mockResolvedValue({ Attributes: { ...assignment } });

      await createRepository(send).update(ref, {
        title: "Lab 3",
        assignmentId: "other",
        courseId: "other",
        userId: "other",
        fileIds: ["x"],
        completedAt: "2026-10-01T00:00:00.000Z",
        deletedAt: "2026-10-01T00:00:00.000Z",
      } as never);

      expect(Object.values(send.mock.calls[0][0].input.ExpressionAttributeNames)).toEqual(["title"]);
    });

    it("never creates an assignment, and returns undefined when it does not exist", async () => {
      const send = vi.fn().mockRejectedValue(conditionalCheckFailed());

      await expect(createRepository(send).update(ref, { title: "Lab 3" })).resolves.toBeUndefined();
      expect(send.mock.calls[0][0].input.ConditionExpression).toBe(EXISTS_CONDITION);
    });
  });

  describe("softDelete", () => {
    it("marks the assignment deleted instead of removing it", async () => {
      const send = vi.fn().mockResolvedValue({});

      await expect(createRepository(send).softDelete(ref, "2026-10-27T12:00:00.000Z")).resolves.toBe(true);

      const input = send.mock.calls[0][0];
      expect(input.constructor.name).toBe("UpdateCommand");
      expect(input.input.UpdateExpression).toBe("SET deletedAt = :deletedAt");
      expect(input.input.ExpressionAttributeValues).toEqual({ ":deletedAt": "2026-10-27T12:00:00.000Z" });
    });

    it("reports false for an assignment that does not exist, and never creates one", async () => {
      const send = vi.fn().mockRejectedValue(conditionalCheckFailed());

      await expect(createRepository(send).softDelete(ref, "2026-10-27T12:00:00.000Z")).resolves.toBe(false);
      expect(send.mock.calls[0][0].input.ConditionExpression).toBe(EXISTS_CONDITION);
    });
  });

  // soft-deleted assignments are a business rule, so the repository returns them like any other and the service filters
  describe("deleted assignments", () => {
    const deleted = { ...assignment, deletedAt: "2026-10-27T12:00:00.000Z" };

    it("are returned by get, deletedAt included", async () => {
      const send = vi.fn().mockResolvedValue({ Item: { PK: "USER#u1", SK: "ASSIGNMENT#c1#a1", ...deleted } });

      await expect(createRepository(send).get(ref)).resolves.toEqual(deleted);
    });

    it("are returned by the lists, which do not filter them in the query either", async () => {
      const send = vi.fn().mockResolvedValue({
        Items: [
          { PK: "USER#u1", SK: "ASSIGNMENT#c1#a1", ...assignment },
          { PK: "USER#u1", SK: "ASSIGNMENT#c1#a2", ...deleted, assignmentId: "a2" },
        ],
      });

      const result = await createRepository(send).listByCourse("u1", "c1");

      expect(result.map((a) => a.assignmentId)).toEqual(["a1", "a2"]);
      expect(send.mock.calls[0][0].input.FilterExpression).toBeUndefined();
    });
  });

  it("rethrows other errors", async () => {
    const send = vi.fn().mockRejectedValue(new Error("throttled"));
    await expect(createRepository(send).addFile(ref, "f1")).rejects.toThrow("throttled");
  });
});
