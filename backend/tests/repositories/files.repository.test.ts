import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { FilesRepository } from "../../src/repositories/files.repository.js";

const ref = { userId: "u1", courseId: "c1", fileId: "f1" };

function conditionalCheckFailed(): Error {
  const err = new Error("conditional check failed");
  err.name = "ConditionalCheckFailedException";
  return err;
}

function createRepository(send: ReturnType<typeof vi.fn>) {
  return new FilesRepository({ send } as unknown as DynamoDBDocumentClient, "table");
}

describe("FilesRepository", () => {
  it("reads a file by its user and course-scoped key, without the key attributes", async () => {
    const send = vi.fn().mockResolvedValue({ Item: { PK: "USER#u1", SK: "FILE#c1#f1", fileId: "f1", status: "uploaded" } });

    const file = await createRepository(send).get(ref);

    expect(send.mock.calls[0][0].input.Key).toEqual({ PK: "USER#u1", SK: "FILE#c1#f1" });
    expect(file).toEqual({ fileId: "f1", status: "uploaded" });
  });

  it("returns undefined for a missing file", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(createRepository(send).get(ref)).resolves.toBeUndefined();
  });

  it("only moves a file out of the statuses it is allowed to leave", async () => {
    const send = vi.fn().mockResolvedValue({});

    const moved = await createRepository(send).transition(ref, ["uploaded"], "parsing", { contentHash: "abc" });

    const input = send.mock.calls[0][0].input;
    expect(moved).toBe(true);
    expect(input.ConditionExpression).toBe("#status IN (:from0)");
    expect(input.ExpressionAttributeValues[":from0"]).toBe("uploaded");
    expect(Object.values(input.ExpressionAttributeValues)).toEqual(
      expect.arrayContaining(["parsing", "abc"]),
    );
  });

  it("reports false instead of throwing when the status condition fails", async () => {
    const send = vi.fn().mockRejectedValue(conditionalCheckFailed());
    await expect(createRepository(send).transition(ref, ["uploaded"], "parsing")).resolves.toBe(false);
  });

  it("rethrows other errors", async () => {
    const send = vi.fn().mockRejectedValue(new Error("throttled"));
    await expect(createRepository(send).transition(ref, ["uploaded"], "parsing")).rejects.toThrow("throttled");
  });

  it("never creates a file when updating", async () => {
    const send = vi.fn().mockResolvedValue({});

    await createRepository(send).update(ref, { bdaInvocationArn: "arn" });

    expect(send.mock.calls[0][0].input.ConditionExpression).toBe("attribute_exists(PK)");
  });

  it("skips undefined fields", async () => {
    const send = vi.fn().mockResolvedValue({});

    await createRepository(send).update(ref, { pageCount: undefined, title: "t" });

    const values = Object.values(send.mock.calls[0][0].input.ExpressionAttributeValues);
    expect(values).toContain("t");
    expect(values).not.toContain(undefined);
  });

  it("lists a course's files with one query on the FILE#<courseId># prefix", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [{ PK: "USER#u1", SK: "FILE#c1#f1", fileId: "f1" }],
    });

    const files = await createRepository(send).listByCourse("u1", "c1");

    expect(files).toEqual([{ fileId: "f1" }]);
    const input = send.mock.calls[0][0].input;
    expect(input.KeyConditionExpression).toBe("PK = :pk AND begins_with(SK, :prefix)");
    expect(input.ExpressionAttributeValues).toEqual({ ":pk": "USER#u1", ":prefix": "FILE#c1#" });
  });

  it("follows pagination when listing files", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [{ fileId: "f1" }], LastEvaluatedKey: { PK: "k" } })
      .mockResolvedValueOnce({ Items: [{ fileId: "f2" }] });

    const files = await createRepository(send).listByCourse("u1", "c1");

    expect(files.map((f) => f.fileId)).toEqual(["f1", "f2"]);
  });

  it("create refuses to overwrite an existing file", async () => {
    const send = vi.fn().mockRejectedValue(conditionalCheckFailed());
    const file = { ...ref, status: "uploaded" } as never;

    await expect(createRepository(send).create(file)).resolves.toBe(false);
  });
});
