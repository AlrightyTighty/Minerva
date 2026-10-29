import { describe, expect, it, vi } from "vitest";
import type { CourseFile, FileStatus } from "../../src/models/items.js";
import { StartParseService } from "../../src/services/start-parse.service.js";

const KEY = "raw/u1/c1/f1/original.pdf";
const ref = { userId: "u1", courseId: "c1", fileId: "f1" };
const waiter = { userId: "u2", courseId: "c2", fileId: "f2" };

function build(overrides: { status?: FileStatus | "missing"; transition?: boolean } = {}) {
  const status = overrides.status ?? "uploaded";
  const files = {
    get: vi.fn().mockResolvedValue(status === "missing" ? undefined : ({ ...ref, status } as CourseFile)),
    transition: vi.fn().mockResolvedValue(overrides.transition ?? true),
    update: vi.fn().mockResolvedValue(true),
  };
  const hashes = {
    claim: vi.fn().mockResolvedValue(true),
    get: vi.fn(),
    addWaiter: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue([]),
  };
  const objects = { sha256: vi.fn().mockResolvedValue({ sha256: "abc123", sizeBytes: 1024 }) };
  const parser = { start: vi.fn().mockResolvedValue("arn:invocation/1") };
  const postProcess = { invokeReuse: vi.fn().mockResolvedValue(undefined) };

  const service = new StartParseService({
    files,
    hashes,
    objects,
    parser,
    postProcess,
    rawBucket: "raw-bucket",
    bdaOutputBucket: "bda-bucket",
  } as never);
  return { service, files, hashes, objects, parser, postProcess };
}

describe("StartParseService", () => {
  it("ignores keys outside raw/", async () => {
    const { service, files } = build();
    await expect(service.handleUpload("processed/u1/c1/f1/full.md")).resolves.toBe("ignored");
    expect(files.get).not.toHaveBeenCalled();
  });

  it("does nothing when the file item does not exist", async () => {
    const { service, parser } = build({ status: "missing" });
    await expect(service.handleUpload(KEY)).resolves.toBe("missing-file");
    expect(parser.start).not.toHaveBeenCalled();
  });

  it.each(["parsing", "ingesting", "ready", "failed"] as const)(
    "treats an event for a %s file as a duplicate and never starts BDA",
    async (status) => {
      const { service, parser, objects } = build({ status });
      await expect(service.handleUpload(KEY)).resolves.toBe("duplicate-event");
      expect(parser.start).not.toHaveBeenCalled();
      expect(objects.sha256).not.toHaveBeenCalled();
    },
  );

  it("fails files BDA cannot parse without starting a job", async () => {
    const { service, files, hashes, parser } = build();

    await expect(service.handleUpload("raw/u1/c1/f1/original.docx")).resolves.toBe("unsupported");

    expect(files.transition).toHaveBeenCalledWith(ref, ["uploaded"], "failed", {
      error: "Unsupported file type: original.docx",
    });
    expect(hashes.claim).not.toHaveBeenCalled();
    expect(parser.start).not.toHaveBeenCalled();
  });

  describe("images", () => {
    // images are stored as-is: no BDA, no Markdown, no knowledge base. Once the bytes are in S3 they are ready to use.
    it.each(["original.png", "original.jpg", "original.webp", "original.gif"])(
      "marks an uploaded %s ready without parsing it",
      async (filename) => {
        const { service, files, hashes, objects, parser, postProcess } = build();

        await expect(service.handleUpload(`raw/u1/c1/f1/${filename}`)).resolves.toBe("stored");

        expect(files.transition).toHaveBeenCalledTimes(1);
        expect(files.transition).toHaveBeenCalledWith(ref, ["uploaded"], "ready");
        expect(objects.sha256).not.toHaveBeenCalled();
        expect(hashes.claim).not.toHaveBeenCalled();
        expect(parser.start).not.toHaveBeenCalled();
        expect(postProcess.invokeReuse).not.toHaveBeenCalled();
      },
    );

    it("treats a repeated event for an image as a duplicate", async () => {
      const { service, files } = build({ status: "ready" });

      await expect(service.handleUpload("raw/u1/c1/f1/original.png")).resolves.toBe("duplicate-event");

      expect(files.transition).not.toHaveBeenCalled();
    });

    it("reports a duplicate when another event already moved the image on", async () => {
      const { service } = build({ transition: false });
      await expect(service.handleUpload("raw/u1/c1/f1/original.png")).resolves.toBe("duplicate-event");
    });

    it("does nothing when the image's file item does not exist", async () => {
      const { service, files } = build({ status: "missing" });

      await expect(service.handleUpload("raw/u1/c1/f1/original.png")).resolves.toBe("missing-file");

      expect(files.transition).not.toHaveBeenCalled();
    });
  });

  it("loses a race with a duplicate event without starting BDA", async () => {
    const { service, hashes, parser } = build({ transition: false });
    await expect(service.handleUpload(KEY)).resolves.toBe("duplicate-event");
    expect(hashes.claim).not.toHaveBeenCalled();
    expect(parser.start).not.toHaveBeenCalled();
  });

  it("starts BDA for content nobody has parsed, with output under the file's own prefix", async () => {
    const { service, files, parser } = build();

    await expect(service.handleUpload(KEY)).resolves.toBe("started");

    expect(files.transition).toHaveBeenCalledWith(ref, ["uploaded"], "parsing", {
      contentHash: "abc123",
      sizeBytes: 1024,
    });
    expect(parser.start).toHaveBeenCalledWith({
      inputUri: "s3://raw-bucket/raw/u1/c1/f1/original.pdf",
      outputUri: "s3://bda-bucket/bda-output/u1/c1/f1/",
      clientToken: "f1-abc123",
    });
    expect(files.update).toHaveBeenCalledWith(ref, { bdaInvocationArn: "arn:invocation/1" });
  });

  it("waits on an identical file that is still parsing instead of starting BDA", async () => {
    const { service, hashes, parser } = build();
    hashes.claim.mockResolvedValue(false);
    hashes.get.mockResolvedValue({ status: "parsing", waiters: [] });

    await expect(service.handleUpload(KEY)).resolves.toBe("waiting");

    expect(hashes.addWaiter).toHaveBeenCalledWith("abc123", ref);
    expect(parser.start).not.toHaveBeenCalled();
  });

  it("reuses the processed Markdown of identical content that already finished", async () => {
    const { service, hashes, parser, postProcess } = build();
    hashes.claim.mockResolvedValue(false);
    hashes.get.mockResolvedValue({
      status: "complete",
      markdownKey: "processed/u9/c9/f9/full.md",
      pageCount: 20,
      waiters: [],
    });

    await expect(service.handleUpload(KEY)).resolves.toBe("reused");

    expect(postProcess.invokeReuse).toHaveBeenCalledWith({
      source: "minerva.start-parse",
      "detail-type": "Reuse Processed Markdown",
      detail: { ref, sourceMarkdownKey: "processed/u9/c9/f9/full.md", pageCount: 20 },
    });
    expect(parser.start).not.toHaveBeenCalled();
  });

  it("re-reads when the parse completes between joining and waiting", async () => {
    const { service, hashes, postProcess } = build();
    hashes.claim.mockResolvedValue(false);
    hashes.get
      .mockResolvedValueOnce({ status: "parsing", waiters: [] })
      .mockResolvedValueOnce({ status: "complete", markdownKey: "processed/u9/c9/f9/full.md", waiters: [] });
    hashes.addWaiter.mockResolvedValue(false);

    await expect(service.handleUpload(KEY)).resolves.toBe("reused");
    expect(postProcess.invokeReuse).toHaveBeenCalledTimes(1);
  });

  it("when BDA fails to start, drops the claim, fails the file and anything waiting", async () => {
    const { service, files, hashes, parser } = build();
    parser.start.mockRejectedValue(new Error("throttled"));
    hashes.release.mockResolvedValue([waiter]);

    await expect(service.handleUpload(KEY)).rejects.toThrow("throttled");

    expect(hashes.release).toHaveBeenCalledWith("abc123");
    expect(files.transition).toHaveBeenCalledWith(waiter, ["parsing"], "failed", { error: "throttled" });
    expect(files.transition).toHaveBeenCalledWith(ref, ["parsing"], "failed", { error: "throttled" });
  });

  it("keeps the claim when BDA started but recording it failed", async () => {
    const { service, files, hashes } = build();
    files.update.mockRejectedValue(new Error("dynamo down"));

    await expect(service.handleUpload(KEY)).rejects.toThrow("dynamo down");

    // the job is running and will report back, so a re-upload must not start a second one
    expect(hashes.release).not.toHaveBeenCalled();
  });
});
