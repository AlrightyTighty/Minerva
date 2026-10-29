import type { IngestionQueue } from "../clients/ingestion-queue.js";
import type { ObjectStore } from "../clients/object-store.js";
import type { Summarizer } from "../clients/summarizer.js";
import {
  BDA_SUCCEEDED,
  REUSE_SOURCE,
  type BdaCompletionEvent,
  type PostProcessEvent,
  type ReuseProcessedEvent,
} from "../models/events.js";
import type { CourseFile, FileRef } from "../models/items.js";
import { bdaOutputPrefix, kbPartKey, kbPrefix, parseRawKey, parseS3Key, processedKey, sidecarKey } from "../models/keys.js";
import type { FilesRepository } from "../repositories/files.repository.js";
import type { ProcessedHashesRepository } from "../repositories/processed-hashes.repository.js";
import { estimateTokens } from "./tokens.js";

export type PostProcessOutcome = "finalized" | "skipped" | "failed" | "missing-file";

export interface PostProcessDeps {
  files: FilesRepository;
  hashes: ProcessedHashesRepository;
  objects: ObjectStore;
  summarizer: Summarizer;
  queue: IngestionQueue;
  bdaOutputBucket: string;
  processedBucket: string;
  kbSourceBucket: string;
}

/** Files larger than this are never auto-hydrated into the chat context. Textbooks are always search-only. */
export const SEARCH_ONLY_TOKENS = 15_000;

/** How much of the document the summary model sees. */
export const SUMMARY_INPUT_CHARS = 12_000;

export function refFromBdaEvent(detail: BdaCompletionEvent["detail"]): FileRef | undefined {
  // the input is our raw/ object and the output prefix is ours too, and both encode the ids
  const fromInput = detail.input_s3_object?.name ? parseRawKey(detail.input_s3_object.name)?.ref : undefined;
  if (fromInput) {
    return fromInput;
  }
  return detail.output_s3_location?.name ? parseS3Key(detail.output_s3_location.name)?.ref : undefined;
}

/** BDA's job_metadata.json lists where each asset's result.json is; collect every standard output path in it. */
export function collectStandardOutputPaths(metadata: unknown): string[] {
  const paths: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "standard_output_path" && typeof value === "string") {
          paths.push(value);
        } else {
          walk(value);
        }
      }
    }
  };
  walk(metadata);
  return paths;
}

export function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) {
    throw new Error(`Not an S3 URI: ${uri}`);
  }
  return { bucket: match[1], key: match[2] };
}

export function buildSidecar(file: Pick<CourseFile, "fileId" | "userId" | "courseId" | "docType">, part: number): string {
  return JSON.stringify({
    metadataAttributes: {
      file_id: file.fileId,
      user_id: file.userId,
      course_id: file.courseId,
      doc_type: file.docType,
      part,
      // flipped by soft delete, so searches can exclude the file's chunks without removing them
      deleted: false,
    },
  });
}

export class PostProcessService {
  constructor(private readonly deps: PostProcessDeps) {}

  async handle(event: PostProcessEvent): Promise<PostProcessOutcome> {
    return event.source === REUSE_SOURCE ? this.handleReuse(event) : this.handleBdaCompletion(event);
  }

  /** The file's content was already parsed: copy that Markdown into this file's own paths. */
  private async handleReuse(event: ReuseProcessedEvent): Promise<PostProcessOutcome> {
    const { ref, sourceMarkdownKey, pageCount } = event.detail;
    const markdown = await this.deps.objects.getText(this.deps.processedBucket, sourceMarkdownKey);
    return this.finalize(ref, markdown, pageCount);
  }

  private async handleBdaCompletion(event: BdaCompletionEvent): Promise<PostProcessOutcome> {
    const { files, hashes } = this.deps;

    const ref = refFromBdaEvent(event.detail);
    if (!ref) {
      throw new Error(`Cannot tell which file this BDA event is for: ${JSON.stringify(event.detail)}`);
    }
    const file = await files.get(ref);
    if (!file) {
      return "missing-file";
    }

    if (event["detail-type"] !== BDA_SUCCEEDED) {
      await this.failParse(ref, file, event.detail.error_message ?? `BDA job did not succeed (${event["detail-type"]})`);
      return "failed";
    }

    const { markdown, pageCount } = await this.readBdaOutput(ref);
    const outcome = await this.finalize(ref, markdown, pageCount);

    // always complete the claim, even on a retry that skipped, so waiting files are never left behind
    if (file.contentHash) {
      const waiters = await hashes.complete(file.contentHash, { markdownKey: processedKey(ref), pageCount });
      await this.finalizeWaiters(waiters, markdown, pageCount);
    }
    return outcome;
  }

  /** Writes everything for one file and hands it to ingestion. Idempotent: only a "parsing" file is moved on. */
  private async finalize(ref: FileRef, markdown: string, pageCount?: number): Promise<PostProcessOutcome> {
    const { files, objects, queue } = this.deps;

    // the processed copy is written first and unconditionally, so it exists for anyone reusing this file's parse
    await objects.putText(this.deps.processedBucket, processedKey(ref), markdown);

    const file = await files.get(ref);
    if (!file) {
      return "missing-file";
    }
    if (file.status !== "parsing") {
      return "skipped";
    }

    const tokenCount = estimateTokens(markdown);
    const searchOnly = file.docType === "textbook" || tokenCount > SEARCH_ONLY_TOKENS;

    // sidecar first, so a source file is never visible without its metadata
    const partKey = kbPartKey(ref, 1);
    await objects.putText(this.deps.kbSourceBucket, sidecarKey(partKey), buildSidecar(file, 1), "application/json");
    await objects.putText(this.deps.kbSourceBucket, partKey, markdown);

    const summary = await this.summarize(file, markdown);

    const moved = await files.transition(ref, ["parsing"], "ingesting", {
      markdownKey: processedKey(ref),
      kbPrefix: kbPrefix(ref),
      tokenCount,
      searchOnly,
      summary,
      pageCount,
    });
    if (!moved) {
      return "skipped";
    }

    try {
      await queue.send({ kind: "start", files: [ref] });
    } catch (err) {
      // nothing else will ever pick this file up, so don't leave it looking like it is still in progress
      await files.transition(ref, ["ingesting"], "failed", {
        error: `Could not queue ingestion: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }
    return "finalized";
  }

  /** A missing summary should not block a file that is otherwise ready, so fall back to its title. */
  private async summarize(file: CourseFile, markdown: string): Promise<string> {
    try {
      return await this.deps.summarizer.summarize(markdown.slice(0, SUMMARY_INPUT_CHARS));
    } catch (err) {
      console.warn(`Summary failed for file ${file.fileId}, using its title`, err);
      return file.title;
    }
  }

  private async finalizeWaiters(waiters: FileRef[], markdown: string, pageCount?: number): Promise<void> {
    for (const waiter of waiters) {
      try {
        await this.finalize(waiter, markdown, pageCount);
      } catch (err) {
        // one bad waiter must not strand the others
        await this.deps.files.transition(waiter, ["parsing"], "failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** The parse failed for good: fail the file, release the claim so a re-upload can retry, and fail anything waiting. */
  private async failParse(ref: FileRef, file: CourseFile, error: string): Promise<void> {
    const { files, hashes } = this.deps;
    await files.transition(ref, ["parsing"], "failed", { error });
    if (file.contentHash) {
      const waiters = await hashes.release(file.contentHash);
      await Promise.all(waiters.map((waiter) => files.transition(waiter, ["parsing"], "failed", { error })));
    }
  }

  private async readBdaOutput(ref: FileRef): Promise<{ markdown: string; pageCount?: number }> {
    const { objects, bdaOutputBucket } = this.deps;

    const keys = await objects.list(bdaOutputBucket, bdaOutputPrefix(ref));
    const metadataKey = keys.filter((key) => key.endsWith("/job_metadata.json")).sort().at(-1);
    if (!metadataKey) {
      throw new Error(`No job_metadata.json under ${bdaOutputPrefix(ref)}`);
    }

    const metadata = JSON.parse(await objects.getText(bdaOutputBucket, metadataKey));
    const [resultUri] = collectStandardOutputPaths(metadata);
    if (!resultUri) {
      throw new Error(`job_metadata.json at ${metadataKey} lists no standard output`);
    }
    const result = parseS3Uri(resultUri);
    const output = JSON.parse(await objects.getText(result.bucket, result.key));

    const markdown: unknown = output.document?.representation?.markdown;
    if (typeof markdown !== "string" || markdown.length === 0) {
      throw new Error(`${resultUri} has no document Markdown`);
    }
    const pageCount: unknown = output.metadata?.number_of_pages ?? output.pages?.length;
    return { markdown, pageCount: typeof pageCount === "number" ? pageCount : undefined };
  }
}
