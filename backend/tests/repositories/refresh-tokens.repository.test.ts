import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { RefreshTokenRecord } from "../../src/models/items.js";
import { RefreshTokensRepository } from "../../src/repositories/refresh-tokens.repository.js";

const record: RefreshTokenRecord = {
  tokenId: "t1",
  userId: "u1",
  familyId: "f1",
  secretHash: "abc123",
  expiresAt: "2026-11-27T12:00:00.000Z",
  createdAt: "2026-10-28T12:00:00.000Z",
  ttl: 1_795_000_000,
};

const conditionalCheckFailed = () => Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });

function createRepository(send: ReturnType<typeof vi.fn>) {
  return new RefreshTokensRepository({ send } as unknown as DynamoDBDocumentClient, "table");
}

describe("RefreshTokensRepository", () => {
  it("stores a token under the user's partition, never overwriting one", async () => {
    const send = vi.fn().mockResolvedValue({});

    await createRepository(send).create(record);

    const input = send.mock.calls[0][0].input;
    expect(input.Item).toEqual({ PK: "USER#u1", SK: "REFRESH#t1", ...record });
    expect(input.ConditionExpression).toBe("attribute_not_exists(PK)");
  });

  it("stores a hash of the secret, with no place to put the secret itself", () => {
    expect(Object.keys(record)).not.toContain("secret");
    expect(Object.keys(record)).toContain("secretHash");
  });

  it("reads a token by user and token id, without the key attributes", async () => {
    const send = vi.fn().mockResolvedValue({ Item: { PK: "USER#u1", SK: "REFRESH#t1", ...record } });

    await expect(createRepository(send).get("u1", "t1")).resolves.toEqual(record);
    expect(send.mock.calls[0][0].input.Key).toEqual({ PK: "USER#u1", SK: "REFRESH#t1" });
  });

  it("returns undefined for a token that does not exist", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(createRepository(send).get("u1", "t9")).resolves.toBeUndefined();
  });

  describe("markUsed", () => {
    it("marks a token used, but only if nobody has used or revoked it yet, so only one of two simultaneous refreshes wins", async () => {
      const send = vi.fn().mockResolvedValue({});

      await expect(createRepository(send).markUsed("u1", "t1", "2026-10-28T12:05:00.000Z")).resolves.toBe(true);

      const input = send.mock.calls[0][0].input;
      expect(input.UpdateExpression).toBe("SET usedAt = :usedAt");
      expect(input.ConditionExpression).toBe(
        "attribute_exists(PK) AND attribute_not_exists(usedAt) AND attribute_not_exists(revokedAt)",
      );
      expect(input.ExpressionAttributeValues).toEqual({ ":usedAt": "2026-10-28T12:05:00.000Z" });
    });

    it("reports false when the token was already used or revoked", async () => {
      const send = vi.fn().mockRejectedValue(conditionalCheckFailed());

      await expect(createRepository(send).markUsed("u1", "t1", "t")).resolves.toBe(false);
    });
  });

  describe("revoke", () => {
    it("revokes a token that is not yet revoked, keeping the first revocation time", async () => {
      const send = vi.fn().mockResolvedValue({});

      await expect(createRepository(send).revoke("u1", "t1", "2026-10-28T12:10:00.000Z")).resolves.toBe(true);

      const input = send.mock.calls[0][0].input;
      expect(input.UpdateExpression).toBe("SET revokedAt = :revokedAt");
      expect(input.ConditionExpression).toBe("attribute_exists(PK) AND attribute_not_exists(revokedAt)");
    });

    it("reports false for a token that is gone or already revoked", async () => {
      const send = vi.fn().mockRejectedValue(conditionalCheckFailed());

      await expect(createRepository(send).revoke("u1", "t1", "t")).resolves.toBe(false);
    });

    it("rethrows other errors", async () => {
      const send = vi.fn().mockRejectedValue(new Error("throttled"));

      await expect(createRepository(send).revoke("u1", "t1", "t")).rejects.toThrow("throttled");
    });
  });

  it("lists all of a user's tokens with one query on the REFRESH# prefix", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [{ PK: "USER#u1", SK: "REFRESH#t1", ...record }] });

    await expect(createRepository(send).listByUser("u1")).resolves.toEqual([record]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues).toEqual({ ":pk": "USER#u1", ":prefix": "REFRESH#" });
  });
});
