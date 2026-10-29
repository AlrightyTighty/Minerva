import type { IngestionQueue } from "../clients/ingestion-queue.js";
import type { KnowledgeBase } from "../clients/knowledge-base.js";
import type { IngestionMessage } from "../models/events.js";
import type { FileRef } from "../models/items.js";
import type { FilesRepository } from "../repositories/files.repository.js";

export interface IngestDeps {
  files: FilesRepository;
  knowledgeBase: KnowledgeBase;
  queue: IngestionQueue;
  now?: () => number;
}

/** How long to wait before looking at a running job again, and before retrying when another job is running. */
export const CHECK_DELAY_SECONDS = 30;
export const BUSY_RETRY_DELAY_SECONDS = 60;

/** A job still running after this long is treated as lost, and its files are failed. */
export const MAX_JOB_AGE_MS = 2 * 60 * 60 * 1000;

const TERMINAL = new Set(["COMPLETE", "FAILED", "STOPPED"]);

const refId = (ref: FileRef) => `${ref.userId}/${ref.courseId}/${ref.fileId}`;

const uniqueRefs = (refs: FileRef[]): FileRef[] => [...new Map(refs.map((ref) => [refId(ref), ref])).values()];

export class IngestService {
  private readonly now: () => number;

  constructor(private readonly deps: IngestDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Handles one batch from the queue. Every step is short and never waits on a job:
   * all "start" messages share one new job, and each job is followed by delayed "check" messages.
   * A job only sees objects that existed when it started, and every file was fully written before
   * it was queued, so the job started here is the one that covers them.
   */
  async handleBatch(messages: IngestionMessage[]): Promise<void> {
    const starts = messages.filter((message) => message.kind === "start");
    if (starts.length > 0) {
      await this.start(uniqueRefs(starts.flatMap((message) => message.files)));
    }
    for (const message of messages) {
      if (message.kind === "check") {
        await this.check(message);
      }
    }
  }

  private async start(refs: FileRef[]): Promise<void> {
    const { knowledgeBase, queue } = this.deps;

    const pending = await this.stillIngesting(refs);
    if (pending.length === 0) {
      return;
    }

    const result = await knowledgeBase.startIngestion();
    if (!result.started) {
      // only one job can run per data source, so try again once the running one has had time to finish
      await queue.send({ kind: "start", files: pending }, BUSY_RETRY_DELAY_SECONDS);
      return;
    }
    await queue.send(
      { kind: "check", jobId: result.jobId, files: pending, startedAt: this.now() },
      CHECK_DELAY_SECONDS,
    );
  }

  private async check(message: Extract<IngestionMessage, { kind: "check" }>): Promise<void> {
    const { files, knowledgeBase, queue } = this.deps;

    const pending = await this.stillIngesting(message.files);
    if (pending.length === 0) {
      return;
    }

    const job = await knowledgeBase.getIngestionJob(message.jobId);

    if (!TERMINAL.has(job.status)) {
      if (this.now() - message.startedAt > MAX_JOB_AGE_MS) {
        await this.failAll(pending, `Ingestion job ${message.jobId} did not finish in time`);
        return;
      }
      await queue.send({ ...message, files: pending }, CHECK_DELAY_SECONDS);
      return;
    }

    if (job.status === "COMPLETE" && job.documentsFailed === 0) {
      await Promise.all(pending.map((ref) => files.transition(ref, ["ingesting"], "ready")));
      return;
    }
    // a failed document is not attributed to a file, so the whole batch fails with the reason
    const reason = job.failureReasons.join("; ") || `Ingestion job ${job.status} (${job.documentsFailed} failed)`;
    await this.failAll(pending, reason);
  }

  /** Anything no longer "ingesting" was already finished, failed or removed, so a redelivered message is harmless. */
  private async stillIngesting(refs: FileRef[]): Promise<FileRef[]> {
    const found = await Promise.all(
      uniqueRefs(refs).map(async (ref) => ({ ref, file: await this.deps.files.get(ref) })),
    );
    return found.filter(({ file }) => file?.status === "ingesting").map(({ ref }) => ref);
  }

  private async failAll(refs: FileRef[], error: string): Promise<void> {
    await Promise.all(refs.map((ref) => this.deps.files.transition(ref, ["ingesting"], "failed", { error })));
  }
}
