import type { FastifyInstance } from "fastify";
import type { DocType } from "../models/items.js";
import type {
  AssignmentFileRequest,
  AssignmentsService,
  CreateAssignmentInput,
  UpdateAssignmentInput,
} from "../services/assignments.service.js";
import { toAssignmentResponse, toFileResponse } from "./mappers.js";

export interface AssignmentsRoutesOptions {
  assignmentsService: AssignmentsService;
}

const DOC_TYPES: DocType[] = ["assignment", "syllabus", "textbook", "notes", "image"];

export async function assignmentsRoutes(app: FastifyInstance, opts: AssignmentsRoutesOptions): Promise<void> {
  const { assignmentsService } = opts;

  app.post<{ Params: { courseId: string }; Body: CreateAssignmentInput }>(
    "/courses/:courseId/assignments",
    {
      schema: {
        body: {
          type: "object",
          required: ["title", "dueAt"],
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1 },
            description: { type: "string" },
            dueAt: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const assignment = await assignmentsService.createAssignment(request.userId, request.params.courseId, request.body);
      return reply.status(201).send(toAssignmentResponse(assignment));
    },
  );

  app.get<{ Params: { courseId: string } }>("/courses/:courseId/assignments", async (request) => {
    const assignments = await assignmentsService.listAssignments(request.userId, request.params.courseId);
    return { assignments: assignments.map(toAssignmentResponse) };
  });

  app.get("/assignments", async (request) => {
    const assignments = await assignmentsService.listAllAssignments(request.userId);
    return { assignments: assignments.map(toAssignmentResponse) };
  });

  app.get<{ Params: { courseId: string; assignmentId: string } }>(
    "/courses/:courseId/assignments/:assignmentId",
    async (request) => {
      const { courseId, assignmentId } = request.params;
      return toAssignmentResponse(await assignmentsService.getAssignment(request.userId, courseId, assignmentId));
    },
  );

  app.patch<{ Params: { courseId: string; assignmentId: string }; Body: UpdateAssignmentInput }>(
    "/courses/:courseId/assignments/:assignmentId",
    {
      schema: {
        body: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1 },
            description: { type: "string" },
            dueAt: { type: "string", minLength: 1 },
            completed: { type: "boolean" },
          },
        },
      },
    },
    async (request) => {
      const { courseId, assignmentId } = request.params;
      const assignment = await assignmentsService.updateAssignment(request.userId, courseId, assignmentId, request.body);
      return toAssignmentResponse(assignment);
    },
  );

  app.delete<{ Params: { courseId: string; assignmentId: string } }>(
    "/courses/:courseId/assignments/:assignmentId",
    async (request, reply) => {
      const { courseId, assignmentId } = request.params;
      await assignmentsService.deleteAssignment(request.userId, courseId, assignmentId);
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { courseId: string; assignmentId: string }; Body: AssignmentFileRequest }>(
    "/courses/:courseId/assignments/:assignmentId/files",
    {
      schema: {
        body: {
          type: "object",
          required: ["filename", "mimeType", "sizeBytes"],
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
      const { courseId, assignmentId } = request.params;
      const { file, upload } = await assignmentsService.createFileUpload(
        request.userId,
        courseId,
        assignmentId,
        request.body,
      );
      return reply.status(201).send({ file: toFileResponse(file), upload });
    },
  );
}
