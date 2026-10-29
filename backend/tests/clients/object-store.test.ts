import { describe, expect, it, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { S3ObjectStore } from "../../src/clients/object-store.js";

function build(response: unknown) {
  const send = vi.fn().mockResolvedValue(response);
  const store = new S3ObjectStore({ send } as unknown as S3Client);
  return { store, send };
}

const bodyOf = (bytes: Uint8Array) => ({ Body: { transformToByteArray: vi.fn().mockResolvedValue(bytes) } });

describe("S3ObjectStore.getBytes", () => {
  it("reads the object from the given bucket and key", async () => {
    const { store, send } = build(bodyOf(new Uint8Array([1])));

    await store.getBytes("raw-bucket", "raw/u1/c1/f1/original.png");

    const input = send.mock.calls[0][0].input;
    expect(input).toEqual({ Bucket: "raw-bucket", Key: "raw/u1/c1/f1/original.png" });
  });

  it("returns the object's bytes unchanged, without decoding them as text", async () => {
    // not valid UTF-8, so any text decoding would corrupt it
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);
    const { store } = build(bodyOf(png));

    const bytes = await store.getBytes("raw-bucket", "key");

    expect(bytes).toEqual(png);
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it("fails, naming the object, when S3 returns no body", async () => {
    const { store } = build({});

    await expect(store.getBytes("raw-bucket", "missing.png")).rejects.toThrow("s3://raw-bucket/missing.png has no body");
  });

  it("lets S3 errors such as a missing object through", async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error("not found"), { name: "NoSuchKey" }));
    const store = new S3ObjectStore({ send } as unknown as S3Client);

    await expect(store.getBytes("raw-bucket", "gone.png")).rejects.toThrow("not found");
  });
});
