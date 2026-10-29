import { describe, expect, it } from "vitest";
import type { CourseFile } from "../../src/models/items.js";
import { CourseNotFoundError } from "../../src/services/courses.service.js";
import { FileNotFoundError, InvalidUploadError } from "../../src/services/files.service.js";
import { AUTH, buildTestApp } from "../support/test-app.js";

// every internal field is set, so the tests prove none of them reach the client
const file: CourseFile = {
  fileId: "f1",
  userId: "u1",
  courseId: "c1",
  originalFilename: "greedy-algorithms.pdf",
  title: "Greedy algorithms",
  docType: "textbook",
  summary: "Covers greedy strategies.",
  rawKey: "raw/u1/c1/f1/original.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  contentHash: "abc123",
  markdownKey: "processed/u1/c1/f1/full.md",
  kbPrefix: "kb-source/u1/c1/f1/",
  status: "ready",
  bdaInvocationArn: "arn:aws:bedrock:us-east-1:123:data-automation-invocation/x",
  pageCount: 20,
  tokenCount: 9000,
  searchOnly: true,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:05:00.000Z",
};

const fileResponse = {
  fileId: "f1",
  courseId: "c1",
  originalFilename: "greedy-algorithms.pdf",
  title: "Greedy algorithms",
  docType: "textbook",
  summary: "Covers greedy strategies.",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  status: "ready",
  pageCount: 20,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:05:00.000Z",
};

const uploadRequest = {
  filename: "greedy-algorithms.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  docType: "textbook",
};

describe("POST /courses/:courseId/files", () => {
  const upload = {
    url: "https://raw-bucket.s3.amazonaws.com/raw/u1/c1/f1/original.pdf?signature=x",
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    expiresAt: "2026-10-26T00:15:00.000Z",
  };

  it("registers the file and returns where to upload it", async () => {
    const { app, services } = buildTestApp();
    services.files.createUpload.mockResolvedValue({ file: { ...file, status: "uploaded" }, upload });

    const response = await app.inject({
      method: "POST",
      url: "/courses/c1/files",
      headers: AUTH,
      payload: uploadRequest,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ file: { ...fileResponse, status: "uploaded" }, upload });
    expect(services.files.createUpload).toHaveBeenCalledWith("u1", "c1", uploadRequest);
  });

  it("passes an optional title through", async () => {
    const { app, services } = buildTestApp();
    services.files.createUpload.mockResolvedValue({ file, upload });

    await app.inject({
      method: "POST",
      url: "/courses/c1/files",
      headers: AUTH,
      payload: { ...uploadRequest, title: "Chapter 3" },
    });

    expect(services.files.createUpload).toHaveBeenCalledWith("u1", "c1", { ...uploadRequest, title: "Chapter 3" });
  });

  it.each([
    ["a missing filename", { ...uploadRequest, filename: undefined }],
    ["a missing size", { ...uploadRequest, sizeBytes: undefined }],
    ["a non-numeric size", { ...uploadRequest, sizeBytes: "big" }],
    ["an unknown docType", { ...uploadRequest, docType: "novel" }],
  ])("rejects %s with 400", async (_label, payload) => {
    const { app, services } = buildTestApp();

    const response = await app.inject({ method: "POST", url: "/courses/c1/files", headers: AUTH, payload });

    expect(response.statusCode).toBe(400);
    expect(services.files.createUpload).not.toHaveBeenCalled();
  });

  it("returns 404 when the course does not exist or is not the caller's", async () => {
    const { app, services } = buildTestApp();
    services.files.createUpload.mockRejectedValue(new CourseNotFoundError("c9"));

    const response = await app.inject({ method: "POST", url: "/courses/c9/files", headers: AUTH, payload: uploadRequest });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ message: 'Course "c9" not found' });
  });

  it("returns 400 with the reason when the upload is not acceptable", async () => {
    const { app, services } = buildTestApp();
    services.files.createUpload.mockRejectedValue(new InvalidUploadError("Only PDF files are supported"));

    const response = await app.inject({ method: "POST", url: "/courses/c1/files", headers: AUTH, payload: uploadRequest });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "Only PDF files are supported" });
  });
});

describe("GET /courses/:courseId/files", () => {
  it("lists the course's files without internal fields", async () => {
    const { app, services } = buildTestApp();
    services.files.listFiles.mockResolvedValue([file]);

    const response = await app.inject({ method: "GET", url: "/courses/c1/files", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ files: [fileResponse] });
    expect(services.files.listFiles).toHaveBeenCalledWith("u1", "c1");
  });

  it("returns 404 for an unknown course", async () => {
    const { app, services } = buildTestApp();
    services.files.listFiles.mockRejectedValue(new CourseNotFoundError("c9"));

    const response = await app.inject({ method: "GET", url: "/courses/c9/files", headers: AUTH });

    expect(response.statusCode).toBe(404);
  });
});

describe("GET /courses/:courseId/files/:fileId/download-url", () => {
  it("returns a temporary URL to view the file the student uploaded", async () => {
    const { app, services } = buildTestApp();
    services.files.getDownloadUrl.mockResolvedValue({
      url: "https://raw-bucket.s3.amazonaws.com/raw/u1/c1/f1/original.pdf?signature=read",
      expiresAt: "2026-10-26T00:15:00.000Z",
    });

    const response = await app.inject({ method: "GET", url: "/courses/c1/files/f1/download-url", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      url: "https://raw-bucket.s3.amazonaws.com/raw/u1/c1/f1/original.pdf?signature=read",
      expiresAt: "2026-10-26T00:15:00.000Z",
    });
    expect(services.files.getDownloadUrl).toHaveBeenCalledWith("u1", "c1", "f1");
  });

  it("returns 404 for a missing file, or one that belongs to someone else", async () => {
    const { app, services } = buildTestApp();
    services.files.getDownloadUrl.mockRejectedValue(new FileNotFoundError("f9"));

    const response = await app.inject({ method: "GET", url: "/courses/c1/files/f9/download-url", headers: AUTH });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ message: 'File "f9" not found' });
  });
});

describe("GET /courses/:courseId/files/:fileId", () => {
  it("returns the file's status, which is how a client follows processing", async () => {
    const { app, services } = buildTestApp();
    services.files.getFile.mockResolvedValue({ ...file, status: "parsing", summary: undefined });

    const response = await app.inject({ method: "GET", url: "/courses/c1/files/f1", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ fileId: "f1", status: "parsing" });
    expect(services.files.getFile).toHaveBeenCalledWith("u1", "c1", "f1");
  });

  it("includes the error when processing failed", async () => {
    const { app, services } = buildTestApp();
    services.files.getFile.mockResolvedValue({ ...file, status: "failed", error: "Unsupported file type" });

    const response = await app.inject({ method: "GET", url: "/courses/c1/files/f1", headers: AUTH });

    expect(response.json()).toMatchObject({ status: "failed", error: "Unsupported file type" });
  });

  it("does not leak internal fields", async () => {
    const { app, services } = buildTestApp();
    services.files.getFile.mockResolvedValue(file);

    const response = await app.inject({ method: "GET", url: "/courses/c1/files/f1", headers: AUTH });

    expect(response.json()).toEqual(fileResponse);
  });

  it("returns 404 for a missing file", async () => {
    const { app, services } = buildTestApp();
    services.files.getFile.mockRejectedValue(new FileNotFoundError("f9"));

    const response = await app.inject({ method: "GET", url: "/courses/c1/files/f9", headers: AUTH });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ message: 'File "f9" not found' });
  });
});
