import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Message } from "../../src/models/items.js";
import { MessagesRepository } from "../../src/repositories/messages.repository.js";

const message = (messageId: string): Message => ({
  messageId,
  role: "user",
  turn: 1,
  contentBlocks: [{ type: "text", text: "hi" }],
  hydratedResourceIds: [],
});

const conditionalCheckFailed = () => Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });

function createRepository(send: ReturnType<typeof vi.fn>) {
  return new MessagesRepository({ send } as unknown as DynamoDBDocumentClient, "table");
}

describe("MessagesRepository", () => {
  it("stores a message under its thread, keyed by its ULID, never overwriting one", async () => {
    const send = vi.fn().mockResolvedValue({});

    await expect(createRepository(send).put("t1", message("01M1"))).resolves.toBe(true);

    const input = send.mock.calls[0][0].input;
    expect(input.Item).toEqual({ PK: "THREAD#t1", SK: "MESSAGE#01M1", ...message("01M1") });
    expect(input.ConditionExpression).toBe("attribute_not_exists(PK)");
  });

  it("reports false when the message id already exists", async () => {
    const send = vi.fn().mockRejectedValue(conditionalCheckFailed());
    await expect(createRepository(send).put("t1", message("01M1"))).resolves.toBe(false);
  });

  describe("listRecent", () => {
    it("reads the newest messages with one limited, newest-first query", async () => {
      const send = vi.fn().mockResolvedValue({ Items: [] });

      await createRepository(send).listRecent("t1", 40);

      expect(send).toHaveBeenCalledTimes(1);
      const input = send.mock.calls[0][0].input;
      expect(input.KeyConditionExpression).toBe("PK = :pk AND begins_with(SK, :prefix)");
      expect(input.ExpressionAttributeValues).toEqual({ ":pk": "THREAD#t1", ":prefix": "MESSAGE#" });
      expect(input.ScanIndexForward).toBe(false);
      expect(input.Limit).toBe(40);
    });

    it("returns them oldest-first, without the key attributes", async () => {
      const send = vi.fn().mockResolvedValue({
        Items: [
          { PK: "THREAD#t1", SK: "MESSAGE#03", ...message("03") },
          { PK: "THREAD#t1", SK: "MESSAGE#02", ...message("02") },
          { PK: "THREAD#t1", SK: "MESSAGE#01", ...message("01") },
        ],
      });

      const result = await createRepository(send).listRecent("t1", 3);

      expect(result.map((m) => m.messageId)).toEqual(["01", "02", "03"]);
      expect(result[0]).toEqual(message("01"));
    });
  });
});
