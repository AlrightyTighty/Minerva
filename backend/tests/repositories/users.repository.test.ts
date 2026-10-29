import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { UsersRepository } from "../../src/repositories/users.repository.js";

const user = {
  userId: "u1",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  studyPreferences: null,
  createdAt: "2026-10-26T00:00:00.000Z",
};

const login = {
  email: "ada@example.com",
  userId: "u1",
  passwordHash: "scrypt$16384$8$1$AAAA$BBBB",
  failedAttempts: 0,
  createdAt: "2026-10-26T00:00:00.000Z",
};

function createRepository(send: ReturnType<typeof vi.fn>) {
  return new UsersRepository({ send } as unknown as DynamoDBDocumentClient, "table");
}

const canceled = (...codes: string[]) =>
  Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

describe("UsersRepository.createWithLogin", () => {
  it("writes the profile and the login in one transaction, so there is never a user without a way to sign in", async () => {
    const send = vi.fn().mockResolvedValue({});

    await expect(createRepository(send).createWithLogin(user, login)).resolves.toBe(true);

    expect(send).toHaveBeenCalledTimes(1);
    const items = send.mock.calls[0][0].input.TransactItems;
    expect(items).toHaveLength(2);
    expect(items[0].Put.Item).toEqual({ PK: "USER#u1", SK: "PROFILE", ...user });
    expect(items[1].Put.Item).toEqual({ PK: "EMAIL#ada@example.com", SK: "LOGIN", ...login });
  });

  it("never overwrites an existing profile or an existing login, which is what makes an email unique", async () => {
    const send = vi.fn().mockResolvedValue({});

    await createRepository(send).createWithLogin(user, login);

    for (const { Put } of send.mock.calls[0][0].input.TransactItems) {
      expect(Put.ConditionExpression).toBe("attribute_not_exists(PK)");
    }
  });

  it("keeps the password hash out of the profile", async () => {
    const send = vi.fn().mockResolvedValue({});

    await createRepository(send).createWithLogin(user, login);

    expect(send.mock.calls[0][0].input.TransactItems[0].Put.Item).not.toHaveProperty("passwordHash");
  });

  it("reports false when the email is already taken", async () => {
    const send = vi.fn().mockRejectedValue(canceled("None", "ConditionalCheckFailed"));

    await expect(createRepository(send).createWithLogin(user, login)).resolves.toBe(false);
  });

  it("throws when the user id is already taken, which should never happen with ULIDs, instead of calling it a taken email", async () => {
    const send = vi.fn().mockRejectedValue(canceled("ConditionalCheckFailed", "None"));

    await expect(createRepository(send).createWithLogin(user, login)).rejects.toThrow();
  });

  it("rethrows other errors", async () => {
    const send = vi.fn().mockRejectedValue(new Error("throttled"));

    await expect(createRepository(send).createWithLogin(user, login)).rejects.toThrow("throttled");
  });
});

describe("UsersRepository", () => {

  describe("update", () => {
    it("sets the study preferences on the profile, and returns the updated profile without the key attributes", async () => {
      const updated = { ...user, studyPreferences: "Short examples first." };
      const send = vi.fn().mockResolvedValue({ Attributes: { PK: "USER#u1", SK: "PROFILE", ...updated } });

      const result = await createRepository(send).update("u1", { studyPreferences: "Short examples first." });

      expect(result).toEqual(updated);
      const input = send.mock.calls[0][0].input;
      expect(input.Key).toEqual({ PK: "USER#u1", SK: "PROFILE" });
      expect(input.UpdateExpression).toBe("SET studyPreferences = :studyPreferences");
      expect(input.ExpressionAttributeValues).toEqual({ ":studyPreferences": "Short examples first." });
      expect(input.ReturnValues).toBe("ALL_NEW");
    });

    it("stores null to clear them", async () => {
      const send = vi.fn().mockResolvedValue({ Attributes: { ...user, studyPreferences: null } });

      await createRepository(send).update("u1", { studyPreferences: null });

      expect(send.mock.calls[0][0].input.ExpressionAttributeValues).toEqual({ ":studyPreferences": null });
    });

    it("never creates a user, and returns undefined when the user does not exist", async () => {
      const error = Object.assign(new Error("missing"), { name: "ConditionalCheckFailedException" });
      const send = vi.fn().mockRejectedValue(error);

      await expect(createRepository(send).update("nobody", { studyPreferences: "x" })).resolves.toBeUndefined();

      expect(send.mock.calls[0][0].input.ConditionExpression).toBe("attribute_exists(PK)");
    });

    it("rethrows other errors", async () => {
      const send = vi.fn().mockRejectedValue(new Error("throttled"));

      await expect(createRepository(send).update("u1", { studyPreferences: "x" })).rejects.toThrow("throttled");
    });
  });

  it("reads a profile without the key attributes", async () => {
    const send = vi.fn().mockResolvedValue({ Item: { PK: "USER#u1", SK: "PROFILE", ...user } });

    await expect(createRepository(send).get("u1")).resolves.toEqual(user);
    expect(send.mock.calls[0][0].input.Key).toEqual({ PK: "USER#u1", SK: "PROFILE" });
  });

  it("returns undefined for an unknown user", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(createRepository(send).get("nobody")).resolves.toBeUndefined();
  });
});
