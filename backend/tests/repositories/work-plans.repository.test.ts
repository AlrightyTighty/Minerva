import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { WorkPlan } from "../../src/models/items.js";
import { WorkPlansRepository } from "../../src/repositories/work-plans.repository.js";

const plan: WorkPlan = {
  workPlanId: "w1",
  userId: "u1",
  startAt: "2026-10-28T14:00:00.000Z",
  endAt: "2026-11-01T14:00:00.000Z",
  timeZone: "America/Chicago",
  workPreferences: null,
  items: [
    {
      itemId: "i1",
      kind: "work",
      name: "Lab 2 (part 1 of 2)",
      description: "Read the handout",
      startAt: "2026-10-28T15:00:00.000Z",
      endAt: "2026-10-28T17:00:00.000Z",
      assignment: { courseId: "c1", assignmentId: "a1" },
      completedAt: null,
    },
  ],
  createdAt: "2026-10-28T13:00:00.000Z",
};

const conditionalCheckFailed = () => Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });

function createRepository(send: ReturnType<typeof vi.fn>) {
  return new WorkPlansRepository({ send } as unknown as DynamoDBDocumentClient, "table");
}

describe("WorkPlansRepository", () => {
  it("stores a plan under USER#<id> / WORKPLAN#<id>, never overwriting one", async () => {
    const send = vi.fn().mockResolvedValue({});

    await expect(createRepository(send).create(plan)).resolves.toBe(true);

    const input = send.mock.calls[0][0].input;
    expect(input.Item).toEqual({ PK: "USER#u1", SK: "WORKPLAN#w1", ...plan });
    expect(input.ConditionExpression).toBe("attribute_not_exists(PK)");
  });

  it("reports false when the plan id already exists", async () => {
    const send = vi.fn().mockRejectedValue(conditionalCheckFailed());
    await expect(createRepository(send).create(plan)).resolves.toBe(false);
  });

  it("reads one plan by user and plan id, without the key attributes, soft-deleted ones included", async () => {
    const deleted = { ...plan, deletedAt: "2026-10-29T00:00:00.000Z" };
    const send = vi.fn().mockResolvedValue({ Item: { PK: "USER#u1", SK: "WORKPLAN#w1", ...deleted } });

    await expect(createRepository(send).get("u1", "w1")).resolves.toEqual(deleted);
    expect(send.mock.calls[0][0].input.Key).toEqual({ PK: "USER#u1", SK: "WORKPLAN#w1" });
  });

  it("returns undefined for a missing plan", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(createRepository(send).get("u1", "w9")).resolves.toBeUndefined();
  });

  it("lists a user's plans with one query on the WORKPLAN# prefix, without filtering any out", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [{ PK: "USER#u1", SK: "WORKPLAN#w1", ...plan }] });

    await expect(createRepository(send).listByUser("u1")).resolves.toEqual([plan]);

    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0][0].input;
    expect(input.ExpressionAttributeValues).toEqual({ ":pk": "USER#u1", ":prefix": "WORKPLAN#" });
    expect(input.FilterExpression).toBeUndefined();
  });

  describe("setItemsCompleted", () => {
    it("sets one item's completion time by position, only if that position still holds that item", async () => {
      const send = vi.fn().mockResolvedValue({});

      await expect(
        createRepository(send).setItemsCompleted("u1", "w1", [
          { index: 2, itemId: "i3", completedAt: "2026-10-28T18:00:00.000Z" },
        ]),
      ).resolves.toBe(true);

      const input = send.mock.calls[0][0].input;
      expect(input.Key).toEqual({ PK: "USER#u1", SK: "WORKPLAN#w1" });
      expect(input.UpdateExpression).toBe("SET #items[2].completedAt = :c0");
      expect(input.ConditionExpression).toBe("attribute_exists(PK) AND #items[2].itemId = :id0");
      expect(input.ExpressionAttributeValues).toEqual({ ":c0": "2026-10-28T18:00:00.000Z", ":id0": "i3" });
    });

    // "items" is a DynamoDB reserved word, so using it in an expression directly is a runtime error
    it("refers to the reserved word items only through an expression attribute name", async () => {
      const send = vi.fn().mockResolvedValue({});

      await createRepository(send).setItemsCompleted("u1", "w1", [
        { index: 0, itemId: "i1", completedAt: null },
        { index: 3, itemId: "i4", completedAt: null },
      ]);

      const input = send.mock.calls[0][0].input;
      expect(input.ExpressionAttributeNames).toEqual({ "#items": "items" });
      for (const expression of [input.UpdateExpression, input.ConditionExpression]) {
        expect(expression).not.toMatch(/(^|[^#\w])items\b/);
      }
    });

    it("clears a completion time with null", async () => {
      const send = vi.fn().mockResolvedValue({});

      await createRepository(send).setItemsCompleted("u1", "w1", [{ index: 0, itemId: "i1", completedAt: null }]);

      expect(send.mock.calls[0][0].input.ExpressionAttributeValues[":c0"]).toBeNull();
    });

    it("changes several items in one write, each guarded by its own id", async () => {
      const send = vi.fn().mockResolvedValue({});

      await createRepository(send).setItemsCompleted("u1", "w1", [
        { index: 0, itemId: "i1", completedAt: "t" },
        { index: 3, itemId: "i4", completedAt: "t" },
      ]);

      expect(send).toHaveBeenCalledTimes(1);
      const input = send.mock.calls[0][0].input;
      expect(input.UpdateExpression).toBe("SET #items[0].completedAt = :c0, #items[3].completedAt = :c1");
      expect(input.ConditionExpression).toBe(
        "attribute_exists(PK) AND #items[0].itemId = :id0 AND #items[3].itemId = :id1",
      );
    });

    it("writes nothing for an empty list", async () => {
      const send = vi.fn();

      await expect(createRepository(send).setItemsCompleted("u1", "w1", [])).resolves.toBe(true);

      expect(send).not.toHaveBeenCalled();
    });

    it.each([-1, 1.5, Number.NaN])("refuses position %s, which is spliced into the update expression", async (index) => {
      const send = vi.fn();

      await expect(
        createRepository(send).setItemsCompleted("u1", "w1", [{ index, itemId: "i1", completedAt: null }]),
      ).rejects.toThrow();

      expect(send).not.toHaveBeenCalled();
    });

    it("reports false, and creates nothing, when the plan is gone or the plan's items have moved", async () => {
      const send = vi.fn().mockRejectedValue(conditionalCheckFailed());

      await expect(
        createRepository(send).setItemsCompleted("u1", "w1", [{ index: 0, itemId: "i1", completedAt: null }]),
      ).resolves.toBe(false);
    });

    it("rethrows other errors", async () => {
      const send = vi.fn().mockRejectedValue(new Error("throttled"));

      await expect(
        createRepository(send).setItemsCompleted("u1", "w1", [{ index: 0, itemId: "i1", completedAt: null }]),
      ).rejects.toThrow("throttled");
    });
  });

  describe("softDelete", () => {
    it("marks the plan deleted instead of removing it", async () => {
      const send = vi.fn().mockResolvedValue({});

      await expect(createRepository(send).softDelete("u1", "w1", "2026-10-29T00:00:00.000Z")).resolves.toBe(true);

      const input = send.mock.calls[0][0].input;
      expect(input.UpdateExpression).toBe("SET deletedAt = :deletedAt");
      expect(input.ExpressionAttributeValues).toEqual({ ":deletedAt": "2026-10-29T00:00:00.000Z" });
      expect(input.ConditionExpression).toBe("attribute_exists(PK)");
    });

    it("reports false for a plan that does not exist", async () => {
      const send = vi.fn().mockRejectedValue(conditionalCheckFailed());

      await expect(createRepository(send).softDelete("u1", "w9", "t")).resolves.toBe(false);
    });
  });
});
