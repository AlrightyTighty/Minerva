import { describe, expect, it } from "vitest";
import type { Assignment, CourseFile } from "../../src/models/items.js";
import { AssignmentNotFoundError, InvalidAssignmentError } from "../../src/services/assignments.service.js";
import { CourseNotFoundError } from "../../src/services/courses.service.js";
import { InvalidUploadError } from "../../src/services/files.service.js";
import { AUTH, buildTestApp } from "../support/test-app.js";

// userId is set, so the tests prove it never reaches the client
const assignment: Assignment = {
  assignmentId: "a1",
  courseId: "c1",
  userId: "u1",
  title: "Lab 2",
  description: "Greedy lab",
  dueAt: "2026-11-01T22:00:00.000Z",
  fileIds: ["f1"],
  completedAt: null,
  createdAt: "2026-10-26T00:00:00.000Z",
};

const assignmentResponse = {
  assignmentId: "a1",
  courseId: "c1",
  title: "Lab 2",
  description: "Greedy lab",
  dueAt: "2026-11-01T22:00:00.000Z",
  fileIds: ["f1"],
  completedAt: null,
  createdAt: "2026-10-26T00:00:00.000Z",
};

describe("POST /courses/:courseId/assignments", () => {
  const body = { title: "Lab 2", description: "Greedy lab", dueAt: "2026-11-01T22:00:00.000Z" };

  it("creates an assignment for the caller in the course", async () => {
    const { app, services } = buildTestApp();
    services.assignments.createAssignment.mockResolvedValue(assignment);

    const response = await app.inject({ method: "POST", url: "/courses/c1/assignments", headers: AUTH, payload: body });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(assignmentResponse);
    expect(services.assignments.createAssignment).toHaveBeenCalledWith("u1", "c1", body);
  });

  it("needs only a title and a due date", async () => {
    const { app, services } = buildTestApp();
    services.assignments.createAssignment.mockResolvedValue(assignment);

    const response = await app.inject({
      method: "POST",
      url: "/courses/c1/assignments",
      headers: AUTH,
      payload: { title: "Lab 2", dueAt: "2026-11-01" },
    });

    expect(response.statusCode).toBe(201);
    expect(services.assignments.createAssignment).toHaveBeenCalledWith("u1", "c1", {
      title: "Lab 2",
      dueAt: "2026-11-01",
    });
  });

  it("ignores fields it does not know, such as a user id or completion time", async () => {
    const { app, services } = buildTestApp();
    services.assignments.createAssignment.mockResolvedValue(assignment);

    await app.inject({
      method: "POST",
      url: "/courses/c1/assignments",
      headers: AUTH,
      payload: { ...body, userId: "someone-else", completedAt: "2026-10-01T00:00:00.000Z", fileIds: ["x"] },
    });

    expect(services.assignments.createAssignment).toHaveBeenCalledWith("u1", "c1", body);
  });

  it.each([
    ["a missing title", { dueAt: body.dueAt }],
    ["an empty title", { title: "", dueAt: body.dueAt }],
    ["a missing due date", { title: "Lab 2" }],
    ["a due date that is not text", { title: "Lab 2", dueAt: 20261101 }],
  ])("rejects %s with 400", async (_label, payload) => {
    const { app, services } = buildTestApp();

    const response = await app.inject({ method: "POST", url: "/courses/c1/assignments", headers: AUTH, payload });

    expect(response.statusCode).toBe(400);
    expect(services.assignments.createAssignment).not.toHaveBeenCalled();
  });

  it("returns 400 with the reason when the service refuses the assignment", async () => {
    const { app, services } = buildTestApp();
    services.assignments.createAssignment.mockRejectedValue(new InvalidAssignmentError("dueAt must be a valid date"));

    const response = await app.inject({ method: "POST", url: "/courses/c1/assignments", headers: AUTH, payload: body });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "dueAt must be a valid date" });
  });

  it("returns 404 when the course does not exist or is not the caller's", async () => {
    const { app, services } = buildTestApp();
    services.assignments.createAssignment.mockRejectedValue(new CourseNotFoundError("c9"));

    const response = await app.inject({ method: "POST", url: "/courses/c9/assignments", headers: AUTH, payload: body });

    expect(response.statusCode).toBe(404);
  });
});

describe("GET /courses/:courseId/assignments", () => {
  it("lists the course's assignments without internal fields", async () => {
    const { app, services } = buildTestApp();
    services.assignments.listAssignments.mockResolvedValue([assignment]);

    const response = await app.inject({ method: "GET", url: "/courses/c1/assignments", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ assignments: [assignmentResponse] });
    expect(services.assignments.listAssignments).toHaveBeenCalledWith("u1", "c1");
  });

  it("returns 404 for an unknown course", async () => {
    const { app, services } = buildTestApp();
    services.assignments.listAssignments.mockRejectedValue(new CourseNotFoundError("c9"));

    const response = await app.inject({ method: "GET", url: "/courses/c9/assignments", headers: AUTH });

    expect(response.statusCode).toBe(404);
  });
});

describe("GET /assignments", () => {
  it("lists the caller's assignments across all their courses", async () => {
    const { app, services } = buildTestApp();
    services.assignments.listAllAssignments.mockResolvedValue([assignment, { ...assignment, assignmentId: "a2", courseId: "c2" }]);

    const response = await app.inject({ method: "GET", url: "/assignments", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json().assignments.map((a: any) => [a.assignmentId, a.courseId])).toEqual([
      ["a1", "c1"],
      ["a2", "c2"],
    ]);
    expect(services.assignments.listAllAssignments).toHaveBeenCalledWith("u1");
  });
});

describe("GET /courses/:courseId/assignments/:assignmentId", () => {
  it("returns the assignment", async () => {
    const { app, services } = buildTestApp();
    services.assignments.getAssignment.mockResolvedValue(assignment);

    const response = await app.inject({ method: "GET", url: "/courses/c1/assignments/a1", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(assignmentResponse);
    expect(services.assignments.getAssignment).toHaveBeenCalledWith("u1", "c1", "a1");
  });

  it("shows when it was completed", async () => {
    const { app, services } = buildTestApp();
    services.assignments.getAssignment.mockResolvedValue({ ...assignment, completedAt: "2026-10-30T00:00:00.000Z" });

    const response = await app.inject({ method: "GET", url: "/courses/c1/assignments/a1", headers: AUTH });

    expect(response.json().completedAt).toBe("2026-10-30T00:00:00.000Z");
  });

  it("returns 404 for a missing assignment", async () => {
    const { app, services } = buildTestApp();
    services.assignments.getAssignment.mockRejectedValue(new AssignmentNotFoundError("a9"));

    const response = await app.inject({ method: "GET", url: "/courses/c1/assignments/a9", headers: AUTH });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ message: 'Assignment "a9" not found' });
  });
});

describe("PATCH /courses/:courseId/assignments/:assignmentId", () => {
  const patch = (app: ReturnType<typeof buildTestApp>["app"], payload: unknown) =>
    app.inject({
      method: "PATCH",
      url: "/courses/c1/assignments/a1",
      headers: AUTH,
      payload: payload as object,
    });

  it("marks the assignment completed and returns it", async () => {
    const { app, services } = buildTestApp();
    services.assignments.updateAssignment.mockResolvedValue({ ...assignment, completedAt: "2026-10-27T12:00:00.000Z" });

    const response = await patch(app, { completed: true });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...assignmentResponse, completedAt: "2026-10-27T12:00:00.000Z" });
    expect(services.assignments.updateAssignment).toHaveBeenCalledWith("u1", "c1", "a1", { completed: true });
  });

  it("marks a completed assignment open again", async () => {
    const { app, services } = buildTestApp();
    services.assignments.updateAssignment.mockResolvedValue(assignment);

    const response = await patch(app, { completed: false });

    expect(response.statusCode).toBe(200);
    expect(response.json().completedAt).toBeNull();
    expect(services.assignments.updateAssignment).toHaveBeenCalledWith("u1", "c1", "a1", { completed: false });
  });

  it("edits the title, description and due date", async () => {
    const { app, services } = buildTestApp();
    services.assignments.updateAssignment.mockResolvedValue({ ...assignment, title: "Lab 3" });
    const changes = { title: "Lab 3", description: "New text", dueAt: "2026-11-08T22:00:00.000Z" };

    const response = await patch(app, changes);

    expect(response.statusCode).toBe(200);
    expect(response.json().title).toBe("Lab 3");
    expect(services.assignments.updateAssignment).toHaveBeenCalledWith("u1", "c1", "a1", changes);
  });

  it("can change fields and completion in one request", async () => {
    const { app, services } = buildTestApp();
    services.assignments.updateAssignment.mockResolvedValue(assignment);

    await patch(app, { title: "Lab 3", completed: true });

    expect(services.assignments.updateAssignment).toHaveBeenCalledWith("u1", "c1", "a1", {
      title: "Lab 3",
      completed: true,
    });
  });

  it("can clear the description", async () => {
    const { app, services } = buildTestApp();
    services.assignments.updateAssignment.mockResolvedValue(assignment);

    await patch(app, { description: "" });

    expect(services.assignments.updateAssignment).toHaveBeenCalledWith("u1", "c1", "a1", { description: "" });
  });

  it("ignores fields that cannot be edited, such as the files or the user", async () => {
    const { app, services } = buildTestApp();
    services.assignments.updateAssignment.mockResolvedValue(assignment);

    await patch(app, { title: "Lab 3", userId: "someone-else", fileIds: ["x"], deletedAt: "2026-10-01T00:00:00.000Z" });

    expect(services.assignments.updateAssignment).toHaveBeenCalledWith("u1", "c1", "a1", { title: "Lab 3" });
  });

  it.each([
    ["no body fields", {}],
    ["a completed value that is not a boolean", { completed: "yes" }],
    ["an empty title", { title: "" }],
    ["a due date that is not text", { dueAt: 20261101 }],
  ])("rejects %s with 400", async (_label, payload) => {
    const { app, services } = buildTestApp();

    const response = await patch(app, payload);

    expect(response.statusCode).toBe(400);
    expect(services.assignments.updateAssignment).not.toHaveBeenCalled();
  });

  it("returns 400 with the reason when the service refuses the change", async () => {
    const { app, services } = buildTestApp();
    services.assignments.updateAssignment.mockRejectedValue(new InvalidAssignmentError("dueAt must be a valid date"));

    const response = await patch(app, { dueAt: "soon" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "dueAt must be a valid date" });
  });

  it("returns 404 for a missing assignment", async () => {
    const { app, services } = buildTestApp();
    services.assignments.updateAssignment.mockRejectedValue(new AssignmentNotFoundError("a1"));

    const response = await patch(app, { completed: true });

    expect(response.statusCode).toBe(404);
  });
});

describe("DELETE /courses/:courseId/assignments/:assignmentId", () => {
  it("deletes the assignment and returns nothing", async () => {
    const { app, services } = buildTestApp();
    services.assignments.deleteAssignment.mockResolvedValue(undefined);

    const response = await app.inject({ method: "DELETE", url: "/courses/c1/assignments/a1", headers: AUTH });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(services.assignments.deleteAssignment).toHaveBeenCalledWith("u1", "c1", "a1");
  });

  it("returns 404 for a missing or already deleted assignment", async () => {
    const { app, services } = buildTestApp();
    services.assignments.deleteAssignment.mockRejectedValue(new AssignmentNotFoundError("a1"));

    const response = await app.inject({ method: "DELETE", url: "/courses/c1/assignments/a1", headers: AUTH });

    expect(response.statusCode).toBe(404);
  });
});

describe("POST /courses/:courseId/assignments/:assignmentId/files", () => {
  const file = {
    fileId: "f-new",
    userId: "u1",
    courseId: "c1",
    originalFilename: "lab2.pdf",
    title: "lab2",
    docType: "assignment",
    rawKey: "raw/u1/c1/f-new/original.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2048,
    contentHash: "abc",
    status: "uploaded",
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
  } as CourseFile;

  const upload = {
    url: "https://raw-bucket.s3.amazonaws.com/raw/u1/c1/f-new/original.pdf?signature=x",
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    expiresAt: "2026-10-27T00:15:00.000Z",
  };

  const request = { filename: "lab2.pdf", mimeType: "application/pdf", sizeBytes: 2048 };

  const send = (app: ReturnType<typeof buildTestApp>["app"], payload: unknown) =>
    app.inject({
      method: "POST",
      url: "/courses/c1/assignments/a1/files",
      headers: AUTH,
      payload: payload as object,
    });

  it("registers a file on the assignment and returns where to upload it", async () => {
    const { app, services } = buildTestApp();
    services.assignments.createFileUpload.mockResolvedValue({ file, upload });

    const response = await send(app, request);

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.upload).toEqual(upload);
    // the same file shape as every other file endpoint, with no internal fields
    expect(body.file).toMatchObject({ fileId: "f-new", courseId: "c1", status: "uploaded", docType: "assignment" });
    expect(body.file).not.toHaveProperty("rawKey");
    expect(body.file).not.toHaveProperty("contentHash");
    expect(body.file).not.toHaveProperty("userId");
    expect(services.assignments.createFileUpload).toHaveBeenCalledWith("u1", "c1", "a1", request);
  });

  it("passes a docType and title through when given", async () => {
    const { app, services } = buildTestApp();
    services.assignments.createFileUpload.mockResolvedValue({ file, upload });

    await send(app, { ...request, docType: "syllabus", title: "Lab 2 handout" });

    expect(services.assignments.createFileUpload).toHaveBeenCalledWith("u1", "c1", "a1", {
      ...request,
      docType: "syllabus",
      title: "Lab 2 handout",
    });
  });

  it.each([
    ["a missing filename", { ...request, filename: undefined }],
    ["a missing size", { ...request, sizeBytes: undefined }],
    ["a size that is not a number", { ...request, sizeBytes: "big" }],
    ["an unknown docType", { ...request, docType: "novel" }],
  ])("rejects %s with 400", async (_label, payload) => {
    const { app, services } = buildTestApp();

    const response = await send(app, payload);

    expect(response.statusCode).toBe(400);
    expect(services.assignments.createFileUpload).not.toHaveBeenCalled();
  });

  it("returns 404 when the assignment does not exist", async () => {
    const { app, services } = buildTestApp();
    services.assignments.createFileUpload.mockRejectedValue(new AssignmentNotFoundError("a1"));

    const response = await send(app, request);

    expect(response.statusCode).toBe(404);
  });

  it("returns 400 with the reason when the upload is not acceptable", async () => {
    const { app, services } = buildTestApp();
    services.assignments.createFileUpload.mockRejectedValue(new InvalidUploadError("File is too large"));

    const response = await send(app, request);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "File is too large" });
  });
});
