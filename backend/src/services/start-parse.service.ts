import type { DocumentParser } from "../clients/document-parser.js";
import type { ObjectStore } from "../clients/object-store.js";
import type { PostProcessInvoker } from "../clients/post-process-invoker.js";
import { REUSE_SOURCE } from "../models/events.js";
import type { FileRef } from "../models/items.js";
import { classifyFilename } from "../models/file-types.js";
import { bdaOutputPrefix, parseRawKey } from "../models/keys.js";
import type { FilesRepository } from "../repositories/files.repository.js";
import type { ProcessedHashesRepository } from "../repositories/processed-hashes.repository.js";

export type StartParseOutcome =
  | "ignored"
  | "missing-file"
  | "duplicate-event"
  | "unsupported"
  | "stored"
  | "started"
  | "waiting"
  | "reused";

export interface StartParseDeps {
  files: FilesRepository;
  hashes: ProcessedHashesRepository;
  objects: ObjectStore;
  parser: DocumentParser;
  postProcess: PostProcessInvoker;
  rawBucket: string;
  bdaOutputBucket: string;
}

/** The claim can change between our reads (completed, or released after a failure), so re-read a few times. */
const MAX_CLAIM_ATTEMPTS = 3;

export class StartParseService {
  constructor(private readonly deps: StartParseDeps) {}

  /** Handles one object created under `raw/`. Safe to call twice for the same upload. */
  async handleUpload(key: string): Promise<StartParseOutcome> {
    const { files, objects } = this.deps;

    const parsed = parseRawKey(key);
    if (!parsed) {
      return "ignored";
    }
    const { ref, filename } = parsed;

    const file = await files.get(ref);
    if (!file) {
      return "missing-file";
    }
    // S3 can deliver an event twice, and any status other than "uploaded" means this upload was already handled
    if (file.status !== "uploaded") {
      return "duplicate-event";
    }
    const type = classifyFilename(filename);
    if (!type) {
      await files.transition(ref, ["uploaded"], "failed", { error: `Unsupported file type: ${filename}` });
      return "unsupported";
    }
    if (type.kind === "image") {
      // images are used as-is, so once the bytes are in S3 there is nothing left to process
      const stored = await files.transition(ref, ["uploaded"], "ready");
      return stored ? "stored" : "duplicate-event";
    }

    const { sha256, sizeBytes } = await objects.sha256(this.deps.rawBucket, key);
    const moved = await files.transition(ref, ["uploaded"], "parsing", { contentHash: sha256, sizeBytes });
    if (!moved) {
      return "duplicate-event";
    }

    try {
      return await this.parseOnce(ref, key, sha256);
    } catch (err) {
      await files.transition(ref, ["parsing"], "failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Runs BDA only if this content has never been claimed, otherwise reuses or waits for the existing result. */
  private async parseOnce(ref: FileRef, key: string, contentHash: string): Promise<StartParseOutcome> {
    const { files, hashes, parser, postProcess } = this.deps;

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      if (await hashes.claim(contentHash)) {
        let invocationArn: string;
        try {
          invocationArn = await parser.start({
            inputUri: `s3://${this.deps.rawBucket}/${key}`,
            outputUri: `s3://${this.deps.bdaOutputBucket}/${bdaOutputPrefix(ref)}`,
            clientToken: `${ref.fileId}-${contentHash}`,
          });
        } catch (err) {
          // no job is running, so drop the claim (a re-upload can try again) and fail anything already waiting
          const error = err instanceof Error ? err.message : String(err);
          const waiters = await hashes.release(contentHash);
          await Promise.all(waiters.map((waiter) => files.transition(waiter, ["parsing"], "failed", { error })));
          throw err;
        }
        // from here the job is running, so the claim must stay
        await files.update(ref, { bdaInvocationArn: invocationArn });
        return "started";
      }

      const existing = await hashes.get(contentHash);
      if (existing?.status === "parsing" && (await hashes.addWaiter(contentHash, ref))) {
        return "waiting";
      }
      if (existing?.status === "complete" && existing.markdownKey) {
        await postProcess.invokeReuse({
          source: REUSE_SOURCE,
          "detail-type": "Reuse Processed Markdown",
          detail: { ref, sourceMarkdownKey: existing.markdownKey, pageCount: existing.pageCount },
        });
        return "reused";
      }
    }
    throw new Error(`Could not claim or join the parse for content ${contentHash}`);
  }
}
