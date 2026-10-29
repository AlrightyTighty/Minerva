import type { FastifyInstance } from "fastify";
import type { DocType } from "../models/items.js";
import type { FilesService, UploadRequest } from "../services/files.service.js";
import { toFileResponse } from "./mappers.js";

export interface FilesRoutesOptions {
  filesService: FilesService;
}

const DOC_TYPES: DocType[] = ["assignment", "syllabus", "textbook", "notes", "image"];

export async function filesRoutes(app: FastifyInstance, opts: FilesRoutesOptions): Promise<void> {
  const { filesService } = opts;

  app.post<{ Params: { courseId: string }; Body: UploadRequest }>(
    "/courses/:courseId/files",
    {
      schema: {
        body: {
          type: "object",
          required: ["filename", "mimeType", "sizeBytes", "docType"],
          additionalProperties: false,
          properties: {
            filename: { type: "string", minLength: 1 },
            mimeType: { type: "string", minLength: 1 },
            sizeBytes: { type: "integer" },
            docType: { type: "string", enum: DOC_TYPES },
            title: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { file, upload } = await filesService.createUpload(
        request.userId,
        request.params.courseId,
        request.body,
      );
      return reply.status(201).send({ file: toFileResponse(file), upload });
    },
  );

  app.get<{ Params: { courseId: string } }>("/courses/:courseId/files", async (request) => {
    const files = await filesService.listFiles(request.userId, request.params.courseId);
    return { files: files.map(toFileResponse) };
  });

  app.get<{ Params: { courseId: string; fileId: string } }>(
    "/courses/:courseId/files/:fileId/download-url",
    async (request) => {
      const { courseId, fileId } = request.params;
      return filesService.getDownloadUrl(request.userId, courseId, fileId);
    },
  );

  app.get<{ Params: { courseId: string; fileId: string } }>(
    "/courses/:courseId/files/:fileId",
    async (request) => {
      const file = await filesService.getFile(request.userId, request.params.courseId, request.params.fileId);
      return toFileResponse(file);
    },
  );
}
