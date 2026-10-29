import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface SignPutInput {
  key: string;
  contentType: string;
  contentLength: number;
  expiresInSeconds: number;
}

export interface SignGetInput {
  key: string;
  expiresInSeconds: number;
  /** What S3 reports the object as, so a viewer renders it properly. */
  contentType: string;
  /** The name to show the file under. */
  filename: string;
}

export interface UploadSigner {
  signPut(input: SignPutInput): Promise<{ url: string }>;
  signGet(input: SignGetInput): Promise<{ url: string }>;
}

/** The plain form of a file name for Content-Disposition: printable ASCII only, and nothing that could end the quoted value. */
const asciiFilename = (filename: string) => filename.replace(/[^\x20-\x7e]|["\\;]/g, "_");

/** RFC 5987 encoding, which also covers the characters encodeURIComponent leaves alone. */
const encodedFilename = (filename: string) =>
  encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export class S3UploadSigner implements UploadSigner {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async signPut(input: SignPutInput): Promise<{ url: string }> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
      }),
      { expiresIn: input.expiresInSeconds },
    );
    return { url };
  }

  async signGet(input: SignGetInput): Promise<{ url: string }> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ResponseContentType: input.contentType,
        // inline, so a viewer shows the file instead of saving it
        ResponseContentDisposition: `inline; filename="${asciiFilename(input.filename)}"; filename*=UTF-8''${encodedFilename(input.filename)}`,
      }),
      { expiresIn: input.expiresInSeconds },
    );
    return { url };
  }
}
