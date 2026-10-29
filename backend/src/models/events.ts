import type { FileRef } from "./items.js";

export const BDA_SUCCEEDED = "Bedrock Data Automation Job Succeeded";

interface S3Location {
  s3_bucket?: string;
  name?: string;
}

/** Bedrock Data Automation completion event, as delivered by EventBridge. Only the fields we use. */
export interface BdaCompletionEvent {
  source: "aws.bedrock";
  "detail-type": string;
  detail: {
    job_id?: string;
    job_status?: string;
    input_s3_object?: S3Location;
    output_s3_location?: S3Location;
    error_message?: string;
  };
}

export const REUSE_SOURCE = "minerva.start-parse";

/** Sent by start-parse when identical content was already processed, so BDA is skipped. */
export interface ReuseProcessedEvent {
  source: typeof REUSE_SOURCE;
  "detail-type": "Reuse Processed Markdown";
  detail: {
    ref: FileRef;
    sourceMarkdownKey: string;
    pageCount?: number;
  };
}

export type PostProcessEvent = BdaCompletionEvent | ReuseProcessedEvent;

/**
 * Messages on the ingestion queue. The ingest Lambda never waits on a job: it starts one, then
 * re-queues a delayed "check" for it, so a 1000 page textbook costs a few short invocations.
 */
export type IngestionMessage =
  | { kind: "start"; files: FileRef[] }
  | { kind: "check"; jobId: string; files: FileRef[]; startedAt: number };
