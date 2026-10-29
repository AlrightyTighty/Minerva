import { describe, expect, it, vi } from "vitest";
import type { CourseFile, FileStatus } from "../../src/models/items.js";
import {
  BUSY_RETRY_DELAY_SECONDS,
  CHECK_DELAY_SECONDS,
  IngestService,
  MAX_JOB_AGE_MS,
} from "../../src/services/ingest.service.js";

const ref1 = { userId: "u1", courseId: "c1", fileId: "f1" };
const ref2 = { userId: "u1", courseId: "c1", fileId: "f2" };
const NOW = 1_000_000;

function build(statuses: Record<string, FileStatus | undefined> = { f1: "ingesting", f2: "ingesting" }) {
  const files = {
    get: vi.fn(async (ref: { fileId: string }) => {
      const status = statuses[ref.fileId];
      return status ? ({ ...ref, status } as CourseFile) : undefined;
    }),
    transition: vi.fn().mockResolvedValue(true),
  };
  const knowledgeBase = {
    startIngestion: vi.fn().mockResolvedValue({ started: true, jobId: "job-1" }),
    getIngestionJob: vi.fn(),
  };
  const queue = { send: vi.fn().mockResolvedValue(undefined) };
  const service = new IngestService({ files, knowledgeBase, queue, now: () => NOW } as never);
  return { service, files, knowledgeBase, queue };
}

describe("IngestService start", () => {
  it("starts a job and queues a delayed check instead of waiting for it", async () => {
    const { service, queue, knowledgeBase } = build();

    await service.handleBatch([{ kind: "start", files: [ref1] }]);

    expect(knowledgeBase.getIngestionJob).not.toHaveBeenCalled();
    expect(queue.send).toHaveBeenCalledWith(
      { kind: "check", jobId: "job-1", files: [ref1], startedAt: NOW },
      CHECK_DELAY_SECONDS,
    );
  });

  it("covers every file in the batch with a single job", async () => {
    const { service, queue, knowledgeBase } = build();

    await service.handleBatch([
      { kind: "start", files: [ref1] },
      { kind: "start", files: [ref2, ref1] },
    ]);

    expect(knowledgeBase.startIngestion).toHaveBeenCalledTimes(1);
    expect(queue.send.mock.calls[0][0].files).toEqual([ref1, ref2]);
  });

  it("retries later when another job is already running", async () => {
    const { service, queue, knowledgeBase } = build();
    knowledgeBase.startIngestion.mockResolvedValue({ started: false });

    await service.handleBatch([{ kind: "start", files: [ref1] }]);

    expect(queue.send).toHaveBeenCalledWith({ kind: "start", files: [ref1] }, BUSY_RETRY_DELAY_SECONDS);
  });

  it("skips files that are no longer ingesting, and starts no job when none are left", async () => {
    const { service, queue, knowledgeBase } = build({ f1: "ready", f2: undefined });

    await service.handleBatch([{ kind: "start", files: [ref1, ref2] }]);

    expect(knowledgeBase.startIngestion).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });
});

describe("IngestService check", () => {
  const check = (startedAt = NOW) => ({ kind: "check" as const, jobId: "job-1", files: [ref1, ref2], startedAt });
  const job = (overrides = {}) => ({ status: "COMPLETE", documentsFailed: 0, failureReasons: [], ...overrides });

  it("checks again later while the job is running", async () => {
    const { service, queue, knowledgeBase, files } = build();
    knowledgeBase.getIngestionJob.mockResolvedValue(job({ status: "IN_PROGRESS" }));

    await service.handleBatch([check()]);

    expect(queue.send).toHaveBeenCalledWith(check(), CHECK_DELAY_SECONDS);
    expect(files.transition).not.toHaveBeenCalled();
  });

  it("marks files ready when the job completes cleanly", async () => {
    const { service, files, knowledgeBase } = build();
    knowledgeBase.getIngestionJob.mockResolvedValue(job());

    await service.handleBatch([check()]);

    expect(files.transition).toHaveBeenCalledWith(ref1, ["ingesting"], "ready");
    expect(files.transition).toHaveBeenCalledWith(ref2, ["ingesting"], "ready");
  });

  it("fails files with the job's reason when it fails", async () => {
    const { service, files, knowledgeBase } = build();
    knowledgeBase.getIngestionJob.mockResolvedValue(job({ status: "FAILED", failureReasons: ["bad document"] }));

    await service.handleBatch([check()]);

    expect(files.transition).toHaveBeenCalledWith(ref1, ["ingesting"], "failed", { error: "bad document" });
  });

  it("does not call a job with failed documents a success", async () => {
    const { service, files, knowledgeBase } = build();
    knowledgeBase.getIngestionJob.mockResolvedValue(job({ documentsFailed: 1 }));

    await service.handleBatch([check()]);

    expect(files.transition).not.toHaveBeenCalledWith(ref1, ["ingesting"], "ready");
    expect(files.transition).toHaveBeenCalledWith(ref1, ["ingesting"], "failed", expect.anything());
  });

  it("gives up on a job that has been running too long", async () => {
    const { service, files, queue, knowledgeBase } = build();
    knowledgeBase.getIngestionJob.mockResolvedValue(job({ status: "IN_PROGRESS" }));

    await service.handleBatch([check(NOW - MAX_JOB_AGE_MS - 1)]);

    expect(queue.send).not.toHaveBeenCalled();
    expect(files.transition).toHaveBeenCalledWith(ref1, ["ingesting"], "failed", expect.anything());
  });

  it("ignores a check for files that already finished", async () => {
    const { service, knowledgeBase } = build({ f1: "ready", f2: "ready" });

    await service.handleBatch([check()]);

    expect(knowledgeBase.getIngestionJob).not.toHaveBeenCalled();
  });
});
