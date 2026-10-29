import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { LoginsRepository } from "../../src/repositories/logins.repository.js";

const login = {
  email: "ada@example.com",
  userId: "u1",
  passwordHash: "scrypt$16384$8$1$AAAA$BBBB",
  failedAttempts: 0,
  createdAt: "2026-10-28T12:00:00.000Z",
};

const conditionalCheckFailed = () => Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });

function createRepository(send: ReturnType<typeof vi.fn>) {
  return new LoginsRepository({ send } as unknown as DynamoDBDocumentClient, "table");
}

describe("LoginsRepository", () => {
  it("reads a login by email, without the key attributes", async () => {
    const send = vi.fn().mockResolvedValue({ Item: { PK: "EMAIL#ada@example.com", SK: "LOGIN", ...login } });

    await expect(createRepository(send).get("ada@example.com")).resolves.toEqual(login);
    expect(send.mock.calls[0][0].input.Key).toEqual({ PK: "EMAIL#ada@example.com", SK: "LOGIN" });
  });

  it("returns undefined for an email nobody has signed up with", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(createRepository(send).get("nobody@example.com")).resolves.toBeUndefined();
  });

  describe("recordFailure", () => {
    it("counts a failed attempt atomically, and returns the new count", async () => {
      const send = vi.fn().mockResolvedValue({ Attributes: { failedAttempts: 3 } });

      await expect(createRepository(send).recordFailure("ada@example.com")).resolves.toBe(3);

      const input = send.mock.calls[0][0].input;
      expect(input.UpdateExpression).toBe("ADD failedAttempts :one");
      expect(input.ExpressionAttributeValues).toEqual({ ":one": 1 });
      expect(input.ReturnValues).toBe("UPDATED_NEW");
    });

    it("never creates a login for an email that does not exist", async () => {
      const send = vi.fn().mockRejectedValue(conditionalCheckFailed());

      await expect(createRepository(send).recordFailure("nobody@example.com")).resolves.toBe(0);
      expect(send.mock.calls[0][0].input.ConditionExpression).toBe("attribute_exists(PK)");
    });
  });

  it("locks an account until a time, and starts the count again", async () => {
    const send = vi.fn().mockResolvedValue({});

    await createRepository(send).lock("ada@example.com", "2026-10-28T12:15:00.000Z");

    const input = send.mock.calls[0][0].input;
    expect(input.UpdateExpression).toBe("SET lockedUntil = :until, failedAttempts = :zero");
    expect(input.ExpressionAttributeValues).toEqual({ ":until": "2026-10-28T12:15:00.000Z", ":zero": 0 });
    expect(input.ConditionExpression).toBe("attribute_exists(PK)");
  });

  it("clears the failures and any lock", async () => {
    const send = vi.fn().mockResolvedValue({});

    await createRepository(send).clearFailures("ada@example.com");

    const input = send.mock.calls[0][0].input;
    expect(input.UpdateExpression).toBe("SET failedAttempts = :zero REMOVE lockedUntil");
    expect(input.ExpressionAttributeValues).toEqual({ ":zero": 0 });
  });

  it("replaces the password hash, and only for a login that exists", async () => {
    const send = vi.fn().mockResolvedValue({});

    await createRepository(send).setPasswordHash("ada@example.com", "scrypt$new");

    const input = send.mock.calls[0][0].input;
    expect(input.Key).toEqual({ PK: "EMAIL#ada@example.com", SK: "LOGIN" });
    expect(input.UpdateExpression).toBe("SET passwordHash = :hash");
    expect(input.ExpressionAttributeValues).toEqual({ ":hash": "scrypt$new" });
    expect(input.ConditionExpression).toBe("attribute_exists(PK)");
  });

  it("rethrows other errors", async () => {
    const send = vi.fn().mockRejectedValue(new Error("throttled"));
    await expect(createRepository(send).lock("ada@example.com", "t")).rejects.toThrow("throttled");
  });
});
