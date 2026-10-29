import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { S3UploadSigner } from "../../src/clients/upload-signer.js";

// signing a URL is done locally from the credentials, so these tests need no network and no real AWS account
const client = new S3Client({
  region: "us-east-2",
  credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
});
const signer = new S3UploadSigner(client, "raw-bucket");

const sign = async (overrides: Partial<Parameters<S3UploadSigner["signGet"]>[0]> = {}) => {
  const { url } = await signer.signGet({
    key: "raw/u1/c1/f1/original.pdf",
    expiresInSeconds: 900,
    contentType: "application/pdf",
    filename: "Greedy Algorithms.pdf",
    ...overrides,
  });
  return new URL(url);
};

describe("S3UploadSigner.signGet", () => {
  it("signs a read of the given object in the bucket", async () => {
    const url = await sign();

    expect(url.hostname.startsWith("raw-bucket.s3.")).toBe(true);
    expect(url.pathname).toBe("/raw/u1/c1/f1/original.pdf");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });

  it("expires after the given time", async () => {
    const url = await sign({ expiresInSeconds: 600 });
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
  });

  it("makes S3 answer with the file's own content type, so a viewer can render it", async () => {
    const url = await sign({ contentType: "image/png" });
    expect(url.searchParams.get("response-content-type")).toBe("image/png");
  });

  it("asks for inline display under the original file name, rather than a download", async () => {
    const url = await sign();

    expect(url.searchParams.get("response-content-disposition")).toBe(
      `inline; filename="Greedy Algorithms.pdf"; filename*=UTF-8''Greedy%20Algorithms.pdf`,
    );
  });

  it("keeps a name with accents readable in the encoded form, and falls back to plain characters in the simple one", async () => {
    const url = await sign({ filename: "résumé.pdf" });

    expect(url.searchParams.get("response-content-disposition")).toBe(
      `inline; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`,
    );
  });

  it("cannot be used to inject header content through the file name", async () => {
    const url = await sign({ filename: 'a"b;c\r\nx-evil: 1.pdf' });

    const disposition = url.searchParams.get("response-content-disposition") ?? "";
    expect(disposition).not.toMatch(/[\r\n]/);
    // the quoted form holds no quote, semicolon or backslash from the name, so it cannot end the value early
    const quoted = /filename="([^"]*)"/.exec(disposition)?.[1] ?? "";
    expect(quoted).not.toMatch(/[";\\]/);
    expect(disposition.startsWith("inline; ")).toBe(true);
  });
});
