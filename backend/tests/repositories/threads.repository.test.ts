import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Thread } from "../../src/models/items.js";
import { ThreadsRepository } from "../../src/repositories/threads.repository.js";

const ref = { userId: "u1", courseId: "c1", threadId: "t1" };

const thread: Thread = {
  threadId: "t1",
  courseId: "c1",
  userId: "u1",
  title: "New chat",
  mode: "concept_review",
  turnCount: 0,
  pinnedResourceIds: [],
  activeResources: {},
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};

const conditionalCheckFailed = () => Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });

function createRepository(send: ReturnType<typeof vi.fn>) {
  return new ThreadsRepository({ send } as unknown as DynamoDBDocumentClient, "table");
}

describe("ThreadsRepository", () => {
  it("stores a thread under the user's partition, never overwriting one", async () => {
    const send = vi.fn().mockResolvedValue({});

    await expect(createRepository(send).create(thread)).resolves.toBe(true);

    const input = send.mock.calls[0][0].input;
    expect(input.Item).toEqual({ PK: "USER#u1", SK: "THREAD#c1#t1", ...thread });
    expect(input.ConditionExpression).toBe("attribute_not_exists(PK)");
  });

  it("reports false when the thread id already exists", async () => {
    const send = vi.fn().mockRejectedValue(conditionalCheckFailed());
    await expect(createRepository(send).create(thread)).resolves.toBe(false);
  });

  it("reads a thread by user, course and thread id, without the key attributes", async () => {
    const send = vi.fn().mockResolvedValue({ Item: { PK: "USER#u1", SK: "THREAD#c1#t1", ...thread } });

    await expect(createRepository(send).get(ref)).resolves.toEqual(thread);
    expect(send.mock.calls[0][0].input.Key).toEqual({ PK: "USER#u1", SK: "THREAD#c1#t1" });
  });

  it("returns undefined for a missing thread", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(createRepository(send).get(ref)).resolves.toBeUndefined();
  });

  it("lists a course's threads with one query on the THREAD#<courseId># prefix", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [{ PK: "USER#u1", SK: "THREAD#c1#t1", ...thread }] });

    await expect(createRepository(send).listByCourse("u1", "c1")).resolves.toEqual([thread]);

    const input = send.mock.calls[0][0].input;
    expect(input.ExpressionAttributeValues).toEqual({ ":pk": "USER#u1", ":prefix": "THREAD#c1#" });
  });

  describe("incrementTurn", () => {
    it("adds one atomically, so two quick messages cannot overwrite each other, and returns the new count", async () => {
      const send = vi.fn().mockResolvedValue({ Attributes: { turnCount: 3 } });

      await expect(createRepository(send).incrementTurn(ref)).resolves.toBe(3);

      const input = send.mock.calls[0][0].input;
      expect(input.Key).toEqual({ PK: "USER#u1", SK: "THREAD#c1#t1" });
      expect(input.UpdateExpression).toMatch(/ADD turnCount :one/);
      expect(input.ExpressionAttributeValues[":one"]).toBe(1);
      expect(input.ReturnValues).toBe("UPDATED_NEW");
    });

    it("never creates a thread that does not exist", async () => {
      const send = vi.fn().mockResolvedValue({ Attributes: { turnCount: 1 } });

      await createRepository(send).incrementTurn(ref);

      expect(send.mock.calls[0][0].input.ConditionExpression).toBe("attribute_exists(PK)");
    });
  });

  describe("setActiveResource", () => {
    it("sets one entry of the map, leaving the others alone", async () => {
      const send = vi.fn().mockResolvedValue({});

      await createRepository(send).setActiveResource(ref, "f1", { loadedAtTurn: 4, expiresAfterTurn: 9 });

      const input = send.mock.calls[0][0].input;
      expect(input.UpdateExpression).toMatch(/SET activeResources\.#file = :resource/);
      expect(input.ExpressionAttributeNames["#file"]).toBe("f1");
      expect(input.ExpressionAttributeValues[":resource"]).toEqual({ loadedAtTurn: 4, expiresAfterTurn: 9 });
      expect(input.ConditionExpression).toBe("attribute_exists(PK)");
    });
  });

  describe("removeActiveResources", () => {
    it("removes just the named entries", async () => {
      const send = vi.fn().mockResolvedValue({});

      await createRepository(send).removeActiveResources(ref, ["f1", "f2"]);

      const input = send.mock.calls[0][0].input;
      expect(input.UpdateExpression).toMatch(/^REMOVE activeResources\.#file0, activeResources\.#file1/);
      expect(input.ExpressionAttributeNames).toMatchObject({ "#file0": "f1", "#file1": "f2" });
    });

    it("does nothing for an empty list", async () => {
      const send = vi.fn();

      await createRepository(send).removeActiveResources(ref, []);

      expect(send).not.toHaveBeenCalled();
    });
  });
});
