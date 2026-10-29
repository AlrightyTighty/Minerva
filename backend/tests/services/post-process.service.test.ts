import { describe, expect, it, vi } from "vitest";
import { BDA_SUCCEEDED, REUSE_SOURCE, type BdaCompletionEvent } from "../../src/models/events.js";
import type { CourseFile, DocType, FileStatus } from "../../src/models/items.js";
import {
  PostProcessService,
  SEARCH_ONLY_TOKENS,
  buildSidecar,
  collectStandardOutputPaths,
  refFromBdaEvent,
} from "../../src/services/post-process.service.js";

const ref = { userId: "u1", courseId: "c1", fileId: "f1" };
const waiter = { userId: "u2", courseId: "c2", fileId: "f2" };

const MARKDOWN = "# Greedy algorithms\n\nPick the locally best option.";
const RESULT_URI = "s3://bda-bucket/bda-output/u1/c1/f1/job-1/0/standard_output/0/result.json";

const successEvent: BdaCompletionEvent = {
  source: "aws.bedrock",
  "detail-type": BDA_SUCCEEDED,
  detail: { input_s3_object: { s3_bucket: "raw-bucket", name: "raw/u1/c1/f1/original.pdf" } },
};

function file(overrides: Partial<CourseFile> = {}): CourseFile {
  return {
    ...ref,
    title: "Greedy algorithms",
    docType: "notes",
    status: "parsing",
    contentHash: "abc123",
    ...overrides,
  } as CourseFile;
}

function build(options: { files?: Record<string, CourseFile | undefined>; markdown?: string } = {}) {
  const stored: Record<string, CourseFile | undefined> = options.files ?? { f1: file(), f2: file({ ...waiter }) };
  const files = {
    get: vi.fn(async (r: { fileId: string }) => stored[r.fileId]),
    transition: vi.fn().mockResolvedValue(true),
  };
  const hashes = {
    complete: vi.fn().mockResolvedValue([]),
    release: vi.fn().mockResolvedValue([]),
  };

  const writes: string[] = [];
  const bucketsByKey = new Map<string, string>();
  const objectBodies: Record<string, string> = {
    "bda-bucket/bda-output/u1/c1/f1/job-1/job_metadata.json": JSON.stringify({
      output_metadata: [{ asset_id: 0, segment_metadata: [{ standard_output_path: RESULT_URI }] }],
    }),
    "bda-bucket/bda-output/u1/c1/f1/job-1/0/standard_output/0/result.json": JSON.stringify({
      document: { representation: { markdown: options.markdown ?? MARKDOWN } },
      metadata: { number_of_pages: 20 },
    }),
    "processed-bucket/processed/u9/c9/f9/full.md": MARKDOWN,
  };
  const objects = {
    list: vi.fn().mockResolvedValue(["bda-output/u1/c1/f1/job-1/job_metadata.json"]),
    getText: vi.fn(async (bucket: string, key: string) => {
      const body = objectBodies[`${bucket}/${key}`];
      if (body === undefined) throw new Error(`no such object ${bucket}/${key}`);
      return body;
    }),
    putText: vi.fn(async (bucket: string, key: string, body: string) => {
      writes.push(`${bucket}/${key}`);
      bucketsByKey.set(`${bucket}/${key}`, body);
    }),
  };
  const summarizer = { summarize: vi.fn().mockResolvedValue("A short summary.") };
  const queue = { send: vi.fn().mockResolvedValue(undefined) };

  const service = new PostProcessService({
    files,
    hashes,
    objects,
    summarizer,
    queue,
    bdaOutputBucket: "bda-bucket",
    processedBucket: "processed-bucket",
    kbSourceBucket: "kb-bucket",
  } as never);
  return { service, files, hashes, objects, summarizer, queue, writes, written: bucketsByKey, stored };
}

describe("PostProcessService BDA completion", () => {
  it("turns BDA output into processed Markdown and one KB part with its sidecar", async () => {
    const { service, objects, written } = build();

    await expect(service.handle(successEvent)).resolves.toBe("finalized");

    expect(objects.putText).toHaveBeenCalledWith("processed-bucket", "processed/u1/c1/f1/full.md", MARKDOWN);
    expect(written.get("kb-bucket/kb-source/u1/c1/f1/part-01.md")).toBe(MARKDOWN);
    expect(JSON.parse(written.get("kb-bucket/kb-source/u1/c1/f1/part-01.md.metadata.json")!)).toEqual({
      metadataAttributes: {
        file_id: "f1",
        user_id: "u1",
        course_id: "c1",
        doc_type: "notes",
        part: 1,
        deleted: false,
      },
    });
  });

  it("writes the sidecar before its source file", async () => {
    const { service, writes } = build();

    await service.handle(successEvent);

    expect(writes.indexOf("kb-bucket/kb-source/u1/c1/f1/part-01.md.metadata.json")).toBeLessThan(
      writes.indexOf("kb-bucket/kb-source/u1/c1/f1/part-01.md"),
    );
  });

  it("records the results on the file and queues ingestion", async () => {
    const { service, files, queue, summarizer } = build();

    await service.handle(successEvent);

    expect(summarizer.summarize).toHaveBeenCalledWith(MARKDOWN);
    expect(files.transition).toHaveBeenCalledWith(ref, ["parsing"], "ingesting", {
      markdownKey: "processed/u1/c1/f1/full.md",
      kbPrefix: "kb-source/u1/c1/f1/",
      tokenCount: Math.ceil(MARKDOWN.length / 4),
      searchOnly: false,
      summary: "A short summary.",
      pageCount: 20,
    });
    expect(queue.send).toHaveBeenCalledWith({ kind: "start", files: [ref] });
  });

  it("marks textbooks and large documents search-only", async () => {
    const textbook = build({ files: { f1: file({ docType: "textbook" as DocType }) } });
    await textbook.service.handle(successEvent);
    expect(textbook.files.transition.mock.calls[0][3]).toMatchObject({ searchOnly: true });

    const large = build({ markdown: "x".repeat(SEARCH_ONLY_TOKENS * 4 + 4) });
    await large.service.handle(successEvent);
    expect(large.files.transition.mock.calls[0][3]).toMatchObject({ searchOnly: true });
  });

  it("falls back to the title when the summary fails, rather than failing the file", async () => {
    const { service, files, summarizer } = build();
    summarizer.summarize.mockRejectedValue(new Error("throttled"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(service.handle(successEvent)).resolves.toBe("finalized");

    expect(files.transition.mock.calls[0][3]).toMatchObject({ summary: "Greedy algorithms" });
  });

  it("does nothing more for a file that is no longer parsing, but still completes the claim", async () => {
    const { service, queue, hashes } = build({ files: { f1: file({ status: "ingesting" as FileStatus }) } });

    await expect(service.handle(successEvent)).resolves.toBe("skipped");

    expect(queue.send).not.toHaveBeenCalled();
    expect(hashes.complete).toHaveBeenCalled();
  });

  it("does not report success if the file moved on between reading and updating", async () => {
    const { service, files, queue } = build();
    files.transition.mockResolvedValue(false);

    await expect(service.handle(successEvent)).resolves.toBe("skipped");
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("completes the claim and finishes files that were waiting on it", async () => {
    const { service, hashes, queue, files } = build();
    hashes.complete.mockResolvedValue([waiter]);

    await service.handle(successEvent);

    expect(hashes.complete).toHaveBeenCalledWith("abc123", {
      markdownKey: "processed/u1/c1/f1/full.md",
      pageCount: 20,
    });
    expect(files.transition).toHaveBeenCalledWith(waiter, ["parsing"], "ingesting", expect.anything());
    expect(queue.send).toHaveBeenCalledWith({ kind: "start", files: [waiter] });
  });

  it("a failing waiter does not strand the others", async () => {
    const third = { userId: "u3", courseId: "c3", fileId: "f3" };
    const { service, hashes, queue, files } = build({
      files: { f1: file(), f2: file({ ...waiter }), f3: file({ ...third }) },
    });
    hashes.complete.mockResolvedValue([waiter, third]);
    queue.send.mockImplementation(async (message: { files: { fileId: string }[] }) => {
      if (message.files[0].fileId === "f2") throw new Error("queue down");
    });

    await service.handle(successEvent);

    expect(files.transition).toHaveBeenCalledWith(waiter, ["ingesting"], "failed", {
      error: "Could not queue ingestion: queue down",
    });
    expect(queue.send).toHaveBeenCalledWith({ kind: "start", files: [third] });
  });

  it("fails the file instead of leaving it ingesting when queueing fails", async () => {
    const { service, files, queue } = build();
    queue.send.mockRejectedValue(new Error("queue down"));

    await expect(service.handle(successEvent)).rejects.toThrow("queue down");

    expect(files.transition).toHaveBeenCalledWith(ref, ["ingesting"], "failed", {
      error: "Could not queue ingestion: queue down",
    });
  });

  it("fails the file, releases the claim and fails waiters when BDA did not succeed", async () => {
    const { service, files, hashes, queue } = build();
    hashes.release.mockResolvedValue([waiter]);

    const outcome = await service.handle({
      ...successEvent,
      "detail-type": "Bedrock Data Automation Job Failed With Client Error",
      detail: { ...successEvent.detail, error_message: "corrupt pdf" },
    });

    expect(outcome).toBe("failed");
    expect(files.transition).toHaveBeenCalledWith(ref, ["parsing"], "failed", { error: "corrupt pdf" });
    expect(hashes.release).toHaveBeenCalledWith("abc123");
    expect(files.transition).toHaveBeenCalledWith(waiter, ["parsing"], "failed", { error: "corrupt pdf" });
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("does nothing for a file that no longer exists", async () => {
    const { service, queue } = build({ files: { f1: undefined } });
    await expect(service.handle(successEvent)).resolves.toBe("missing-file");
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("refuses an event it cannot attribute to a file", async () => {
    const { service } = build();
    await expect(service.handle({ ...successEvent, detail: {} })).rejects.toThrow("Cannot tell which file");
  });

  it("fails loudly when BDA output is missing, so the event is retried", async () => {
    const { service, objects } = build();
    objects.list.mockResolvedValue([]);
    await expect(service.handle(successEvent)).rejects.toThrow("No job_metadata.json");
  });
});

describe("PostProcessService reuse", () => {
  it("copies the earlier file's Markdown into this file's own paths without BDA output", async () => {
    const { service, objects, queue, written } = build();

    await expect(
      service.handle({
        source: REUSE_SOURCE,
        "detail-type": "Reuse Processed Markdown",
        detail: { ref, sourceMarkdownKey: "processed/u9/c9/f9/full.md", pageCount: 20 },
      }),
    ).resolves.toBe("finalized");

    expect(objects.list).not.toHaveBeenCalled();
    expect(written.get("processed-bucket/processed/u1/c1/f1/full.md")).toBe(MARKDOWN);
    expect(written.get("kb-bucket/kb-source/u1/c1/f1/part-01.md")).toBe(MARKDOWN);
    expect(queue.send).toHaveBeenCalledWith({ kind: "start", files: [ref] });
  });
});

describe("BDA output helpers", () => {
  it("finds standard output paths wherever they are nested", () => {
    expect(
      collectStandardOutputPaths({
        output_metadata: [
          { asset_id: 0, segment_metadata: [{ standard_output_path: "s3://b/a.json" }] },
          { asset_id: 1, segment_metadata: [{ standard_output_path: "s3://b/b.json" }] },
        ],
      }),
    ).toEqual(["s3://b/a.json", "s3://b/b.json"]);
    expect(collectStandardOutputPaths({})).toEqual([]);
  });

  it("identifies the file from the input object, falling back to the output location", () => {
    expect(refFromBdaEvent({ input_s3_object: { name: "raw/u1/c1/f1/original.pdf" } })).toEqual(ref);
    expect(refFromBdaEvent({ output_s3_location: { name: "bda-output/u1/c1/f1/job-1" } })).toEqual(ref);
    expect(refFromBdaEvent({})).toBeUndefined();
  });

  it("builds sidecars that start un-deleted", () => {
    const sidecar = JSON.parse(buildSidecar({ ...ref, docType: "textbook" }, 1));
    expect(sidecar.metadataAttributes).toMatchObject({ doc_type: "textbook", deleted: false });
  });
});
