import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ProcessedHashesRepository } from "../../src/repositories/processed-hashes.repository.js";

const waiter = { userId: "u2", courseId: "c2", fileId: "f2" };

function conditionalCheckFailed(): Error {
  const err = new Error("conditional check failed");
  err.name = "ConditionalCheckFailedException";
  return err;
}

function createRepository(send: ReturnType<typeof vi.fn>) {
  return new ProcessedHashesRepository({ send } as unknown as DynamoDBDocumentClient, "table");
}

describe("ProcessedHashesRepository", () => {
  it("claims content only if nobody has claimed it", async () => {
    const send = vi.fn().mockResolvedValue({});

    await expect(createRepository(send).claim("abc")).resolves.toBe(true);

    const input = send.mock.calls[0][0].input;
    expect(input.Item).toMatchObject({ PK: "HASH#abc", SK: "PROCESSED", status: "parsing", waiters: [] });
    expect(input.Item.ttl).toBeGreaterThan(Date.now() / 1000);
    expect(input.ConditionExpression).toBe("attribute_not_exists(PK)");
  });

  it("loses the claim when one already exists", async () => {
    const send = vi.fn().mockRejectedValue(conditionalCheckFailed());
    await expect(createRepository(send).claim("abc")).resolves.toBe(false);
  });

  it("adds a waiter only while the parse is still running", async () => {
    const send = vi.fn().mockResolvedValue({});

    await expect(createRepository(send).addWaiter("abc", waiter)).resolves.toBe(true);

    const input = send.mock.calls[0][0].input;
    expect(input.ConditionExpression).toBe("#status = :parsing");
    expect(input.ExpressionAttributeValues[":waiter"]).toEqual([waiter]);
  });

  it("reports false when the parse already completed", async () => {
    const send = vi.fn().mockRejectedValue(conditionalCheckFailed());
    await expect(createRepository(send).addWaiter("abc", waiter)).resolves.toBe(false);
  });

  it("completes the parse, clears the claim ttl and returns the waiters", async () => {
    const send = vi.fn().mockResolvedValue({ Attributes: { waiters: [waiter] } });

    const waiters = await createRepository(send).complete("abc", { markdownKey: "processed/u1/c1/f1/full.md", pageCount: 20 });

    const input = send.mock.calls[0][0].input;
    expect(input.UpdateExpression).toContain("REMOVE #ttl");
    expect(waiters).toEqual([waiter]);
  });

  it("returns no waiters when the claim has already expired", async () => {
    const send = vi.fn().mockRejectedValue(conditionalCheckFailed());
    await expect(createRepository(send).complete("abc", { markdownKey: "k" })).resolves.toEqual([]);
  });

  it("releases a claim and returns who was waiting on it", async () => {
    const send = vi.fn().mockResolvedValue({ Attributes: { waiters: [waiter] } });

    await expect(createRepository(send).release("abc")).resolves.toEqual([waiter]);
    expect(send.mock.calls[0][0].input.ReturnValues).toBe("ALL_OLD");
  });

  it("releasing a missing claim returns no waiters", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(createRepository(send).release("abc")).resolves.toEqual([]);
  });
});
