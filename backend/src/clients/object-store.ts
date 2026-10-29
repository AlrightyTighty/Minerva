import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";

export interface ObjectStore {
  getText(bucket: string, key: string): Promise<string>;
  /** The object's raw bytes, for content that must not be decoded as text (images). */
  getBytes(bucket: string, key: string): Promise<Uint8Array>;
  putText(bucket: string, key: string, body: string, contentType?: string): Promise<void>;
  /** Keys under the prefix, in S3's lexicographic order. */
  list(bucket: string, prefix: string): Promise<string[]>;
  /** SHA-256 of the object's bytes, streamed so large PDFs never sit in memory. */
  sha256(bucket: string, key: string): Promise<{ sha256: string; sizeBytes: number }>;
}

export class S3ObjectStore implements ObjectStore {
  constructor(private readonly client: S3Client) {}

  async getText(bucket: string, key: string): Promise<string> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!response.Body) {
      throw new Error(`s3://${bucket}/${key} has no body`);
    }
    return response.Body.transformToString("utf-8");
  }

  async getBytes(bucket: string, key: string): Promise<Uint8Array> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!response.Body) {
      throw new Error(`s3://${bucket}/${key} has no body`);
    }
    return response.Body.transformToByteArray();
  }

  async putText(bucket: string, key: string, body: string, contentType = "text/markdown"): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async list(bucket: string, prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
      );
      keys.push(...(response.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : [])));
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);
    return keys;
  }

  async sha256(bucket: string, key: string): Promise<{ sha256: string; sizeBytes: number }> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!response.Body) {
      throw new Error(`s3://${bucket}/${key} has no body`);
    }
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of response.Body as Readable) {
      hash.update(chunk);
      sizeBytes += chunk.length;
    }
    return { sha256: hash.digest("hex"), sizeBytes };
  }
}
