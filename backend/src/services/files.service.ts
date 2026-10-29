import type { UploadSigner } from "../clients/upload-signer.js";
import { classifyFilename, storedFilename } from "../models/file-types.js";
import type { CourseFile, DocType } from "../models/items.js";
import { rawKey } from "../models/keys.js";
import type { FilesRepository } from "../repositories/files.repository.js";
import type { CoursesService } from "./courses.service.js";

export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

export const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

export class InvalidUploadError extends Error {}

export class FileNotFoundError extends Error {
  constructor(fileId: string) {
    super(`File "${fileId}" not found`);
  }
}

export interface UploadRequest {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  docType: DocType;
  title?: string;
}

export interface UploadTarget {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

export interface FilesServiceDeps {
  files: FilesRepository;
  courses: CoursesService;
  signer: UploadSigner;
  newId: () => string;
  now: () => Date;
}

const EXTENSION = /\.[^./]+$/;

export class FilesService {
  constructor(private readonly deps: FilesServiceDeps) {}

  /**
   * Registers the file as "uploaded" and returns a presigned URL for the client to PUT it to.
   * The upload landing in S3 is what starts processing, and by then this item already exists.
   */
  async createUpload(
    userId: string,
    courseId: string,
    request: UploadRequest,
  ): Promise<{ file: CourseFile; upload: UploadTarget }> {
    const { files, courses, signer, newId, now } = this.deps;

    this.validate(request);
    await courses.getCourse(userId, courseId);

    const fileId = newId();
    const timestamp = now().toISOString();
    const file: CourseFile = {
      fileId,
      userId,
      courseId,
      originalFilename: request.filename,
      title: request.title?.trim() || request.filename.replace(EXTENSION, ""),
      docType: request.docType,
      rawKey: rawKey({ userId, courseId, fileId }, storedFilename(request.filename)),
      mimeType: request.mimeType,
      sizeBytes: request.sizeBytes,
      status: "uploaded",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (!(await files.create(file))) {
      throw new Error(`File id collision for ${fileId}`);
    }

    const { url } = await signer.signPut({
      key: file.rawKey,
      contentType: request.mimeType,
      contentLength: request.sizeBytes,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    });
    return {
      file,
      upload: {
        url,
        method: "PUT",
        headers: { "Content-Type": request.mimeType },
        expiresAt: new Date(now().getTime() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
      },
    };
  }

  async listFiles(userId: string, courseId: string): Promise<CourseFile[]> {
    await this.deps.courses.getCourse(userId, courseId);
    const files = await this.deps.files.listByCourse(userId, courseId);
    return files.filter((file) => !file.deletedAt);
  }

  /** A temporary URL to view the file as it was uploaded. Works in every status, so a student can always see their upload. */
  async getDownloadUrl(
    userId: string,
    courseId: string,
    fileId: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const file = await this.getFile(userId, courseId, fileId);
    const { url } = await this.deps.signer.signGet({
      key: file.rawKey,
      expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
      contentType: file.mimeType,
      filename: file.originalFilename,
    });
    return { url, expiresAt: new Date(this.deps.now().getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString() };
  }

  /** Files are keyed by user, so another user's file is simply not found. */
  async getFile(userId: string, courseId: string, fileId: string): Promise<CourseFile> {
    const file = await this.deps.files.get({ userId, courseId, fileId });
    if (!file || file.deletedAt) {
      throw new FileNotFoundError(fileId);
    }
    return file;
  }

  private validate(request: UploadRequest): void {
    const type = classifyFilename(request.filename);
    if (!type) {
      throw new InvalidUploadError(
        "Unsupported file type: only PDF and image (PNG, JPEG, WebP, GIF) files can be uploaded",
      );
    }
    if (request.mimeType !== type.mimeType) {
      throw new InvalidUploadError("File type does not match its extension");
    }
    if (type.kind === "image" && request.docType !== "image") {
      throw new InvalidUploadError('An image must have docType "image"');
    }
    if (type.kind === "pdf" && request.docType === "image") {
      throw new InvalidUploadError('Only images can have docType "image"');
    }
    if (request.sizeBytes <= 0) {
      throw new InvalidUploadError("File is empty");
    }
    if (request.sizeBytes > type.maxBytes) {
      throw new InvalidUploadError("File is too large");
    }
  }
}
