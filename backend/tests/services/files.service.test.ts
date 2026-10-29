import { describe, expect, it, vi } from "vitest";
import type { CourseFile } from "../../src/models/items.js";
import { CourseNotFoundError } from "../../src/services/courses.service.js";
import {
  FileNotFoundError,
  FilesService,
  InvalidUploadError,
  DOWNLOAD_URL_TTL_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
} from "../../src/services/files.service.js";
import { MAX_IMAGE_BYTES, MAX_PDF_BYTES } from "../../src/models/file-types.js";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const SIGNED_URL = "https://raw-bucket.s3.amazonaws.com/raw/u1/c1/f-new/original.pdf?signature=x";
const READ_URL = "https://raw-bucket.s3.amazonaws.com/raw/u1/c1/f1/original.pdf?signature=read";

const request = {
  filename: "Greedy Algorithms.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  docType: "textbook" as const,
};

const stored = (overrides: Partial<CourseFile> = {}): CourseFile =>
  ({
    fileId: "f1",
    userId: "u1",
    courseId: "c1",
    status: "ready",
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  }) as CourseFile;

function build() {
  const files = {
    create: vi.fn().mockResolvedValue(true),
    get: vi.fn(),
    listByCourse: vi.fn(),
  };
  const courses = { getCourse: vi.fn().mockResolvedValue({ courseId: "c1", userId: "u1" }) };
  const signer = {
    signPut: vi.fn().mockResolvedValue({ url: SIGNED_URL }),
    signGet: vi.fn().mockResolvedValue({ url: READ_URL }),
  };
  const service = new FilesService({ files, courses, signer, newId: () => "f-new", now: () => NOW } as never);
  return { service, files, courses, signer };
}

describe("FilesService.createUpload", () => {
  it("registers the file as uploaded, ready for the S3 event that will follow the upload", async () => {
    const { service, files } = build();

    const { file } = await service.createUpload("u1", "c1", request);

    expect(files.create).toHaveBeenCalledWith({
      fileId: "f-new",
      userId: "u1",
      courseId: "c1",
      originalFilename: "Greedy Algorithms.pdf",
      title: "Greedy Algorithms",
      docType: "textbook",
      rawKey: "raw/u1/c1/f-new/original.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      status: "uploaded",
      createdAt: "2026-10-26T12:00:00.000Z",
      updatedAt: "2026-10-26T12:00:00.000Z",
    });
    expect(file.fileId).toBe("f-new");
    expect(file.status).toBe("uploaded");
  });

  it("uses the given title instead of the filename", async () => {
    const { service, files } = build();

    await service.createUpload("u1", "c1", { ...request, title: "  Chapter 3  " });

    expect(files.create.mock.calls[0][0].title).toBe("Chapter 3");
  });

  it("returns a presigned PUT bound to the key, type and size, and when it expires", async () => {
    const { service, signer } = build();

    const { upload } = await service.createUpload("u1", "c1", request);

    expect(signer.signPut).toHaveBeenCalledWith({
      key: "raw/u1/c1/f-new/original.pdf",
      contentType: "application/pdf",
      contentLength: 2048,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    });
    expect(upload).toEqual({
      url: SIGNED_URL,
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      expiresAt: new Date(NOW.getTime() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    });
  });

  it("accepts an uppercase .PDF extension", async () => {
    const { service } = build();
    await expect(service.createUpload("u1", "c1", { ...request, filename: "NOTES.PDF" })).resolves.toBeDefined();
  });

  it.each([
    ["photo.png", "image/png", "original.png"],
    ["photo.jpg", "image/jpeg", "original.jpg"],
    ["photo.jpeg", "image/jpeg", "original.jpg"],
    ["diagram.webp", "image/webp", "original.webp"],
    ["anim.gif", "image/gif", "original.gif"],
  ])("accepts the image %s and stores it as %s", async (filename, mimeType, stored) => {
    const { service, files, signer } = build();

    const { file, upload } = await service.createUpload("u1", "c1", {
      filename,
      mimeType,
      sizeBytes: 1024,
      docType: "image",
    });

    expect(file.rawKey).toBe(`raw/u1/c1/f-new/${stored}`);
    expect(file.status).toBe("uploaded");
    expect(files.create.mock.calls[0][0].docType).toBe("image");
    expect(signer.signPut).toHaveBeenCalledWith(
      expect.objectContaining({ key: `raw/u1/c1/f-new/${stored}`, contentType: mimeType, contentLength: 1024 }),
    );
    expect(upload.headers).toEqual({ "Content-Type": mimeType });
  });

  it("titles an image after its filename without the extension", async () => {
    const { service } = build();

    const { file } = await service.createUpload("u1", "c1", {
      filename: "whiteboard.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      docType: "image",
    });

    expect(file.title).toBe("whiteboard");
  });

  it("accepts an image exactly at the image size limit", async () => {
    const { service } = build();
    await expect(
      service.createUpload("u1", "c1", {
        filename: "big.png",
        mimeType: "image/png",
        sizeBytes: MAX_IMAGE_BYTES,
        docType: "image",
      }),
    ).resolves.toBeDefined();
  });

  const image = { filename: "photo.png", mimeType: "image/png", sizeBytes: 1024, docType: "image" as const };
  const NOT_SUPPORTED = "Unsupported file type: only PDF and image (PNG, JPEG, WebP, GIF) files can be uploaded";

  it.each([
    ["a file type that is not supported", { ...request, filename: "notes.docx" }, NOT_SUPPORTED],
    ["a text file (notes are added client-side, not uploaded)", { ...request, filename: "notes.md" }, NOT_SUPPORTED],
    ["a file with no extension", { ...request, filename: "notes" }, NOT_SUPPORTED],
    ["an empty file", { ...request, sizeBytes: 0 }, "File is empty"],
    ["a PDF over the size limit", { ...request, sizeBytes: MAX_PDF_BYTES + 1 }, "File is too large"],
    ["an image over the image size limit", { ...image, sizeBytes: MAX_IMAGE_BYTES + 1 }, "File is too large"],
    ["a PDF sent with an image MIME type", { ...request, mimeType: "image/png" }, "File type does not match its extension"],
    ["an image sent as a PDF", { ...image, mimeType: "application/pdf" }, "File type does not match its extension"],
    ["a jpg sent as a png", { ...image, filename: "photo.jpg" }, "File type does not match its extension"],
    ["an image with a document docType", { ...image, docType: "notes" as const }, "An image must have docType \"image\""],
    ["a PDF with the image docType", { ...request, docType: "image" as const }, "Only images can have docType \"image\""],
  ])("rejects %s without creating anything", async (_label, input, message) => {
    const { service, files, signer } = build();

    await expect(service.createUpload("u1", "c1", input)).rejects.toThrow(new InvalidUploadError(message));

    expect(files.create).not.toHaveBeenCalled();
    expect(signer.signPut).not.toHaveBeenCalled();
  });

  it("accepts a PDF exactly at the PDF size limit", async () => {
    const { service } = build();
    await expect(service.createUpload("u1", "c1", { ...request, sizeBytes: MAX_PDF_BYTES })).resolves.toBeDefined();
  });

  it("checks the course belongs to the user first, and creates nothing if it does not", async () => {
    const { service, courses, files, signer } = build();
    courses.getCourse.mockRejectedValue(new CourseNotFoundError("c9"));

    await expect(service.createUpload("u1", "c9", request)).rejects.toThrow(CourseNotFoundError);

    expect(courses.getCourse).toHaveBeenCalledWith("u1", "c9");
    expect(files.create).not.toHaveBeenCalled();
    expect(signer.signPut).not.toHaveBeenCalled();
  });

  it("does not hand out an upload URL if the file could not be registered", async () => {
    const { service, files, signer } = build();
    files.create.mockResolvedValue(false);

    await expect(service.createUpload("u1", "c1", request)).rejects.toThrow();

    expect(signer.signPut).not.toHaveBeenCalled();
  });
});

describe("FilesService.listFiles", () => {
  it("lists the course's files that are not deleted, after checking the course", async () => {
    const { service, files, courses } = build();
    files.listByCourse.mockResolvedValue([
      stored(),
      stored({ fileId: "f2", deletedAt: "2026-10-20T00:00:00.000Z" }),
      stored({ fileId: "f3", status: "parsing" }),
    ]);

    const result = await service.listFiles("u1", "c1");

    expect(courses.getCourse).toHaveBeenCalledWith("u1", "c1");
    expect(files.listByCourse).toHaveBeenCalledWith("u1", "c1");
    expect(result.map((f) => f.fileId)).toEqual(["f1", "f3"]);
  });

  it("throws CourseNotFoundError for a course the user does not have", async () => {
    const { service, courses, files } = build();
    courses.getCourse.mockRejectedValue(new CourseNotFoundError("c9"));

    await expect(service.listFiles("u1", "c9")).rejects.toThrow(CourseNotFoundError);
    expect(files.listByCourse).not.toHaveBeenCalled();
  });
});

describe("FilesService.getDownloadUrl", () => {
  const original = stored({
    rawKey: "raw/u1/c1/f1/original.pdf",
    mimeType: "application/pdf",
    originalFilename: "Greedy Algorithms.pdf",
  });

  it("signs a read URL for the file's original upload, shown inline under its own name and type", async () => {
    const { service, files, signer } = build();
    files.get.mockResolvedValue(original);

    const result = await service.getDownloadUrl("u1", "c1", "f1");

    expect(files.get).toHaveBeenCalledWith({ userId: "u1", courseId: "c1", fileId: "f1" });
    expect(signer.signGet).toHaveBeenCalledWith({
      key: "raw/u1/c1/f1/original.pdf",
      expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
      contentType: "application/pdf",
      filename: "Greedy Algorithms.pdf",
    });
    expect(result).toEqual({
      url: READ_URL,
      expiresAt: new Date(NOW.getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    });
  });

  it.each(["uploaded", "parsing", "ingesting", "ready", "failed"] as const)(
    "works for a file in the %s status, so a student can always see what they uploaded",
    async (status) => {
      const { service, files } = build();
      files.get.mockResolvedValue({ ...original, status });

      await expect(service.getDownloadUrl("u1", "c1", "f1")).resolves.toMatchObject({ url: READ_URL });
    },
  );

  it("throws FileNotFoundError for a missing file, which also covers another user's file, and signs nothing", async () => {
    const { service, files, signer } = build();
    files.get.mockResolvedValue(undefined);

    await expect(service.getDownloadUrl("u1", "c1", "f9")).rejects.toThrow(FileNotFoundError);

    expect(signer.signGet).not.toHaveBeenCalled();
  });

  it("treats a soft-deleted file as not found", async () => {
    const { service, files, signer } = build();
    files.get.mockResolvedValue({ ...original, deletedAt: "2026-10-20T00:00:00.000Z" });

    await expect(service.getDownloadUrl("u1", "c1", "f1")).rejects.toThrow(FileNotFoundError);

    expect(signer.signGet).not.toHaveBeenCalled();
  });
});

describe("FilesService.getFile", () => {
  it("returns the file in any status", async () => {
    const { service, files } = build();
    files.get.mockResolvedValue(stored({ status: "failed" }));

    await expect(service.getFile("u1", "c1", "f1")).resolves.toMatchObject({ fileId: "f1", status: "failed" });
    expect(files.get).toHaveBeenCalledWith({ userId: "u1", courseId: "c1", fileId: "f1" });
  });

  it("throws FileNotFoundError when it does not exist (which also covers another user's file)", async () => {
    const { service, files } = build();
    files.get.mockResolvedValue(undefined);

    await expect(service.getFile("u1", "c1", "f9")).rejects.toThrow(FileNotFoundError);
  });

  it("treats a soft-deleted file as not found", async () => {
    const { service, files } = build();
    files.get.mockResolvedValue(stored({ deletedAt: "2026-10-20T00:00:00.000Z" }));

    await expect(service.getFile("u1", "c1", "f1")).rejects.toThrow(FileNotFoundError);
  });
});
