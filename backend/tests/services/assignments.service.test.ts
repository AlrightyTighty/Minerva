import { describe, expect, it, vi } from "vitest";
import type { Assignment } from "../../src/models/items.js";
import {
  AssignmentNotFoundError,
  AssignmentsService,
  InvalidAssignmentError,
} from "../../src/services/assignments.service.js";
import { CourseNotFoundError } from "../../src/services/courses.service.js";
import { InvalidUploadError } from "../../src/services/files.service.js";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const ref = { userId: "u1", courseId: "c1", assignmentId: "a1" };

const assignment = (overrides: Partial<Assignment> = {}): Assignment => ({
  assignmentId: "a1",
  courseId: "c1",
  userId: "u1",
  title: "Lab 2",
  description: "",
  dueAt: "2026-11-01T22:00:00.000Z",
  fileIds: [],
  completedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const upload = { file: { fileId: "f-new", courseId: "c1" }, upload: { url: "https://s3/x", method: "PUT" } };

const deletedAssignment = (overrides: Partial<Assignment> = {}) =>
  assignment({ deletedAt: "2026-10-20T00:00:00.000Z", ...overrides });

// the repository returns soft-deleted assignments like any other. Treating them as gone is the service's job.
function build() {
  const assignments = {
    create: vi.fn().mockResolvedValue(true),
    get: vi.fn().mockResolvedValue(assignment()),
    listByCourse: vi.fn().mockResolvedValue([]),
    listByUser: vi.fn().mockResolvedValue([]),
    addFile: vi.fn().mockResolvedValue(true),
    setCompleted: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn().mockResolvedValue(true),
  };
  const courses = { getCourse: vi.fn().mockResolvedValue({ courseId: "c1", userId: "u1" }) };
  const files = { createUpload: vi.fn().mockResolvedValue(upload) };
  // keeps work plans in step with the assignment's completion
  const planSync = { syncAssignment: vi.fn().mockResolvedValue(undefined) };
  const service = new AssignmentsService({
    assignments,
    courses,
    files,
    planSync,
    newId: () => "a-new",
    now: () => NOW,
  } as never);
  return { service, assignments, courses, files, planSync };
}

describe("AssignmentsService.createAssignment", () => {
  it("creates an open assignment with no files, owned by the user", async () => {
    const { service, assignments } = build();

    const created = await service.createAssignment("u1", "c1", {
      title: "Lab 2",
      description: "Greedy lab",
      dueAt: "2026-11-01T22:00:00.000Z",
    });

    expect(created).toEqual({
      assignmentId: "a-new",
      courseId: "c1",
      userId: "u1",
      title: "Lab 2",
      description: "Greedy lab",
      dueAt: "2026-11-01T22:00:00.000Z",
      fileIds: [],
      completedAt: null,
      createdAt: "2026-10-27T12:00:00.000Z",
    });
    expect(assignments.create).toHaveBeenCalledWith(created);
  });

  it("trims the title and defaults the description to empty", async () => {
    const { service } = build();

    const created = await service.createAssignment("u1", "c1", { title: "  Lab 2  ", dueAt: "2026-11-01T22:00:00.000Z" });

    expect(created.title).toBe("Lab 2");
    expect(created.description).toBe("");
  });

  it.each([
    ["an offset date-time", "2026-11-01T17:00:00-05:00", "2026-11-01T22:00:00.000Z"],
    ["a plain date", "2026-11-01", "2026-11-01T00:00:00.000Z"],
  ])("stores %s as UTC", async (_label, input, stored) => {
    const { service } = build();

    const created = await service.createAssignment("u1", "c1", { title: "Lab", dueAt: input });

    expect(created.dueAt).toBe(stored);
  });

  it.each([
    ["a blank title", { title: "   ", dueAt: "2026-11-01T22:00:00.000Z" }],
    ["a due date that is not a date", { title: "Lab", dueAt: "next tuesday" }],
  ])("rejects %s without creating anything", async (_label, input) => {
    const { service, assignments } = build();

    await expect(service.createAssignment("u1", "c1", input)).rejects.toThrow(InvalidAssignmentError);

    expect(assignments.create).not.toHaveBeenCalled();
  });

  it("checks the course belongs to the user, and creates nothing if it does not", async () => {
    const { service, courses, assignments } = build();
    courses.getCourse.mockRejectedValue(new CourseNotFoundError("c9"));

    await expect(
      service.createAssignment("u1", "c9", { title: "Lab", dueAt: "2026-11-01T22:00:00.000Z" }),
    ).rejects.toThrow(CourseNotFoundError);

    expect(courses.getCourse).toHaveBeenCalledWith("u1", "c9");
    expect(assignments.create).not.toHaveBeenCalled();
  });
});

describe("AssignmentsService listing", () => {
  const due = (assignmentId: string, dueAt: string) => assignment({ assignmentId, dueAt });

  it("lists a course's assignments, soonest due first, after checking the course", async () => {
    const { service, assignments, courses } = build();
    assignments.listByCourse.mockResolvedValue([
      due("late", "2026-12-01T00:00:00.000Z"),
      due("soon", "2026-11-01T00:00:00.000Z"),
      due("mid", "2026-11-15T00:00:00.000Z"),
    ]);

    const result = await service.listAssignments("u1", "c1");

    expect(courses.getCourse).toHaveBeenCalledWith("u1", "c1");
    expect(assignments.listByCourse).toHaveBeenCalledWith("u1", "c1");
    expect(result.map((a) => a.assignmentId)).toEqual(["soon", "mid", "late"]);
  });

  it("throws CourseNotFoundError for a course the user does not have", async () => {
    const { service, courses, assignments } = build();
    courses.getCourse.mockRejectedValue(new CourseNotFoundError("c9"));

    await expect(service.listAssignments("u1", "c9")).rejects.toThrow(CourseNotFoundError);
    expect(assignments.listByCourse).not.toHaveBeenCalled();
  });

  it("lists all of the user's assignments across courses, soonest due first", async () => {
    const { service, assignments } = build();
    assignments.listByUser.mockResolvedValue([
      assignment({ assignmentId: "b", courseId: "c2", dueAt: "2026-11-20T00:00:00.000Z" }),
      assignment({ assignmentId: "a", courseId: "c1", dueAt: "2026-11-02T00:00:00.000Z" }),
    ]);

    const result = await service.listAllAssignments("u1");

    expect(assignments.listByUser).toHaveBeenCalledWith("u1");
    expect(result.map((a) => a.assignmentId)).toEqual(["a", "b"]);
  });

  it("leaves soft-deleted assignments out of a course's list", async () => {
    const { service, assignments } = build();
    assignments.listByCourse.mockResolvedValue([
      assignment({ assignmentId: "kept" }),
      deletedAssignment({ assignmentId: "gone" }),
    ]);

    const result = await service.listAssignments("u1", "c1");

    expect(result.map((a) => a.assignmentId)).toEqual(["kept"]);
  });

  it("leaves soft-deleted assignments out of the list across courses", async () => {
    const { service, assignments } = build();
    assignments.listByUser.mockResolvedValue([
      assignment({ assignmentId: "kept" }),
      deletedAssignment({ assignmentId: "gone" }),
    ]);

    const result = await service.listAllAssignments("u1");

    expect(result.map((a) => a.assignmentId)).toEqual(["kept"]);
  });
});

describe("AssignmentsService.getAssignment", () => {
  it("returns the assignment", async () => {
    const { service, assignments } = build();

    await expect(service.getAssignment("u1", "c1", "a1")).resolves.toEqual(assignment());
    expect(assignments.get).toHaveBeenCalledWith(ref);
  });

  it("throws AssignmentNotFoundError when it does not exist, or belongs to another user or course", async () => {
    const { service, assignments } = build();
    assignments.get.mockResolvedValue(undefined);

    await expect(service.getAssignment("u1", "c1", "a9")).rejects.toThrow(AssignmentNotFoundError);
  });

  it("treats a soft-deleted assignment as not found", async () => {
    const { service, assignments } = build();
    assignments.get.mockResolvedValue(deletedAssignment());

    await expect(service.getAssignment("u1", "c1", "a1")).rejects.toThrow(AssignmentNotFoundError);
  });
});

describe("AssignmentsService.updateAssignment", () => {
  describe("fields", () => {
    it("edits the title, description and due date, and returns the updated assignment", async () => {
      const { service, assignments } = build();
      const updated = assignment({ title: "Lab 3", description: "New", dueAt: "2026-11-08T22:00:00.000Z" });
      assignments.update.mockResolvedValue(updated);

      const result = await service.updateAssignment("u1", "c1", "a1", {
        title: "Lab 3",
        description: "New",
        dueAt: "2026-11-08T22:00:00.000Z",
      });

      expect(result).toEqual(updated);
      expect(assignments.update).toHaveBeenCalledWith(ref, {
        title: "Lab 3",
        description: "New",
        dueAt: "2026-11-08T22:00:00.000Z",
      });
    });

    it("changes only what is given", async () => {
      const { service, assignments } = build();
      assignments.update.mockResolvedValue(assignment({ title: "Lab 3" }));

      await service.updateAssignment("u1", "c1", "a1", { title: "Lab 3" });

      expect(assignments.update).toHaveBeenCalledWith(ref, { title: "Lab 3" });
    });

    it("trims the title and stores the due date as UTC", async () => {
      const { service, assignments } = build();
      assignments.update.mockResolvedValue(assignment());

      await service.updateAssignment("u1", "c1", "a1", { title: "  Lab 3  ", dueAt: "2026-11-01T17:00:00-05:00" });

      expect(assignments.update).toHaveBeenCalledWith(ref, { title: "Lab 3", dueAt: "2026-11-01T22:00:00.000Z" });
    });

    it("can clear the description", async () => {
      const { service, assignments } = build();
      assignments.update.mockResolvedValue(assignment());

      await service.updateAssignment("u1", "c1", "a1", { description: "" });

      expect(assignments.update).toHaveBeenCalledWith(ref, { description: "" });
    });

    it.each([
      ["a blank title", { title: "  " }],
      ["a due date that is not a date", { dueAt: "soon" }],
      ["nothing to change", {}],
    ])("rejects %s without writing anything", async (_label, changes) => {
      const { service, assignments } = build();

      await expect(service.updateAssignment("u1", "c1", "a1", changes)).rejects.toThrow(InvalidAssignmentError);

      expect(assignments.update).not.toHaveBeenCalled();
      expect(assignments.setCompleted).not.toHaveBeenCalled();
    });
  });

  describe("completion", () => {
    it("marks an open assignment completed now, and returns it", async () => {
      const { service, assignments } = build();
      const done = assignment({ completedAt: "2026-10-27T12:00:00.000Z" });
      assignments.setCompleted.mockResolvedValue(done);

      await expect(service.updateAssignment("u1", "c1", "a1", { completed: true })).resolves.toEqual(done);

      expect(assignments.setCompleted).toHaveBeenCalledWith(ref, "2026-10-27T12:00:00.000Z");
      expect(assignments.update).not.toHaveBeenCalled();
    });

    it("marks a completed assignment open again", async () => {
      const { service, assignments } = build();
      assignments.get.mockResolvedValue(assignment({ completedAt: "2026-10-20T00:00:00.000Z" }));
      assignments.setCompleted.mockResolvedValue(assignment());

      await service.updateAssignment("u1", "c1", "a1", { completed: false });

      expect(assignments.setCompleted).toHaveBeenCalledWith(ref, null);
    });

    it("keeps the original completion time when it is already completed, and writes nothing", async () => {
      const { service, assignments } = build();
      const already = assignment({ completedAt: "2026-10-20T00:00:00.000Z" });
      assignments.get.mockResolvedValue(already);

      await expect(service.updateAssignment("u1", "c1", "a1", { completed: true })).resolves.toEqual(already);

      expect(assignments.setCompleted).not.toHaveBeenCalled();
    });

    it("writes nothing when it is already open", async () => {
      const { service, assignments } = build();

      await expect(service.updateAssignment("u1", "c1", "a1", { completed: false })).resolves.toEqual(assignment());

      expect(assignments.setCompleted).not.toHaveBeenCalled();
    });
  });

  it("applies fields and completion together, and returns the result of both", async () => {
    const { service, assignments } = build();
    assignments.update.mockResolvedValue(assignment({ title: "Lab 3" }));
    const both = assignment({ title: "Lab 3", completedAt: "2026-10-27T12:00:00.000Z" });
    assignments.setCompleted.mockResolvedValue(both);

    const result = await service.updateAssignment("u1", "c1", "a1", { title: "Lab 3", completed: true });

    expect(assignments.update).toHaveBeenCalledWith(ref, { title: "Lab 3" });
    expect(assignments.setCompleted).toHaveBeenCalledWith(ref, "2026-10-27T12:00:00.000Z");
    expect(result).toEqual(both);
  });

  it("writes nothing, and throws AssignmentNotFoundError, for an assignment that does not exist", async () => {
    const { service, assignments } = build();
    assignments.get.mockResolvedValue(undefined);

    await expect(service.updateAssignment("u1", "c1", "a9", { title: "x", completed: true })).rejects.toThrow(
      AssignmentNotFoundError,
    );

    expect(assignments.update).not.toHaveBeenCalled();
    expect(assignments.setCompleted).not.toHaveBeenCalled();
  });

  it("throws AssignmentNotFoundError when it disappears between the read and the write", async () => {
    const { service, assignments } = build();
    assignments.update.mockResolvedValue(undefined);

    await expect(service.updateAssignment("u1", "c1", "a1", { title: "Lab 3" })).rejects.toThrow(
      AssignmentNotFoundError,
    );
  });

  it("cannot change a soft-deleted assignment, and writes nothing", async () => {
    const { service, assignments } = build();
    assignments.get.mockResolvedValue(deletedAssignment());

    await expect(service.updateAssignment("u1", "c1", "a1", { title: "x", completed: true })).rejects.toThrow(
      AssignmentNotFoundError,
    );

    expect(assignments.update).not.toHaveBeenCalled();
    expect(assignments.setCompleted).not.toHaveBeenCalled();
  });
});

describe("AssignmentsService: keeping work plans in step", () => {
  it("tells the work plans when an assignment is completed, with the time it was completed", async () => {
    const { service, assignments, planSync } = build();
    assignments.setCompleted.mockResolvedValue(assignment({ completedAt: "2026-10-27T12:00:00.000Z" }));

    await service.updateAssignment("u1", "c1", "a1", { completed: true });

    expect(planSync.syncAssignment).toHaveBeenCalledWith("u1", { courseId: "c1", assignmentId: "a1" }, "2026-10-27T12:00:00.000Z");
  });

  it("tells the work plans when an assignment is reopened", async () => {
    const { service, assignments, planSync } = build();
    assignments.get.mockResolvedValue(assignment({ completedAt: "2026-10-20T00:00:00.000Z" }));
    assignments.setCompleted.mockResolvedValue(assignment());

    await service.updateAssignment("u1", "c1", "a1", { completed: false });

    expect(planSync.syncAssignment).toHaveBeenCalledWith("u1", { courseId: "c1", assignmentId: "a1" }, null);
  });

  it("tells them nothing when the completion did not change, or only other fields did", async () => {
    const { service, assignments, planSync } = build();
    assignments.get.mockResolvedValue(assignment({ completedAt: "2026-10-20T00:00:00.000Z" }));
    assignments.update.mockResolvedValue(assignment({ title: "Lab 3", completedAt: "2026-10-20T00:00:00.000Z" }));

    await service.updateAssignment("u1", "c1", "a1", { completed: true });
    await service.updateAssignment("u1", "c1", "a1", { title: "Lab 3" });

    expect(planSync.syncAssignment).not.toHaveBeenCalled();
  });

  it("still returns the updated assignment when the work plans could not be updated, since it is already saved", async () => {
    const { service, assignments, planSync } = build();
    const done = assignment({ completedAt: "2026-10-27T12:00:00.000Z" });
    assignments.setCompleted.mockResolvedValue(done);
    planSync.syncAssignment.mockRejectedValue(new Error("dynamo down"));

    await expect(service.updateAssignment("u1", "c1", "a1", { completed: true })).resolves.toEqual(done);
  });

  describe("setCompletionFromPlan, used when it is the work plan that finished the assignment", () => {
    it("completes the assignment now, and returns it", async () => {
      const { service, assignments } = build();
      const done = assignment({ completedAt: "2026-10-27T12:00:00.000Z" });
      assignments.setCompleted.mockResolvedValue(done);

      await expect(service.setCompletionFromPlan("u1", "c1", "a1", true)).resolves.toEqual(done);

      expect(assignments.setCompleted).toHaveBeenCalledWith(ref, "2026-10-27T12:00:00.000Z");
    });

    it("reopens a completed assignment", async () => {
      const { service, assignments } = build();
      assignments.get.mockResolvedValue(assignment({ completedAt: "2026-10-20T00:00:00.000Z" }));
      assignments.setCompleted.mockResolvedValue(assignment());

      await service.setCompletionFromPlan("u1", "c1", "a1", false);

      expect(assignments.setCompleted).toHaveBeenCalledWith(ref, null);
    });

    it("does not tell the work plans, which already know, so one part being undone cannot reopen all of them", async () => {
      const { service, assignments, planSync } = build();
      assignments.get.mockResolvedValue(assignment({ completedAt: "2026-10-20T00:00:00.000Z" }));
      assignments.setCompleted.mockResolvedValue(assignment());

      await service.setCompletionFromPlan("u1", "c1", "a1", false);

      expect(planSync.syncAssignment).not.toHaveBeenCalled();
    });

    it("keeps the original completion time, and writes nothing, when it is already completed", async () => {
      const { service, assignments } = build();
      const already = assignment({ completedAt: "2026-10-20T00:00:00.000Z" });
      assignments.get.mockResolvedValue(already);

      await expect(service.setCompletionFromPlan("u1", "c1", "a1", true)).resolves.toEqual(already);

      expect(assignments.setCompleted).not.toHaveBeenCalled();
    });

    it("throws AssignmentNotFoundError for an assignment that is gone or deleted", async () => {
      const { service, assignments } = build();
      assignments.get.mockResolvedValue(deletedAssignment());

      await expect(service.setCompletionFromPlan("u1", "c1", "a1", true)).rejects.toThrow(AssignmentNotFoundError);
    });
  });
});

describe("AssignmentsService.deleteAssignment", () => {
  it("soft-deletes the assignment now", async () => {
    const { service, assignments } = build();

    await service.deleteAssignment("u1", "c1", "a1");

    expect(assignments.softDelete).toHaveBeenCalledWith(ref, "2026-10-27T12:00:00.000Z");
  });

  it("throws AssignmentNotFoundError for one that does not exist", async () => {
    const { service, assignments } = build();
    assignments.get.mockResolvedValue(undefined);

    await expect(service.deleteAssignment("u1", "c1", "a9")).rejects.toThrow(AssignmentNotFoundError);

    expect(assignments.softDelete).not.toHaveBeenCalled();
  });

  it("throws AssignmentNotFoundError for one that is already deleted, and keeps the first deletion time", async () => {
    const { service, assignments } = build();
    assignments.get.mockResolvedValue(deletedAssignment());

    await expect(service.deleteAssignment("u1", "c1", "a1")).rejects.toThrow(AssignmentNotFoundError);

    expect(assignments.softDelete).not.toHaveBeenCalled();
  });

  it("throws AssignmentNotFoundError when it disappears between the read and the write", async () => {
    const { service, assignments } = build();
    assignments.softDelete.mockResolvedValue(false);

    await expect(service.deleteAssignment("u1", "c1", "a1")).rejects.toThrow(AssignmentNotFoundError);
  });

  it("leaves the assignment's files in the course", async () => {
    const { service, files } = build();

    await service.deleteAssignment("u1", "c1", "a1");

    expect(files.createUpload).not.toHaveBeenCalled();
  });
});

describe("AssignmentsService.createFileUpload", () => {
  const request = { filename: "lab2.pdf", mimeType: "application/pdf", sizeBytes: 2048 };

  it("registers the file in the assignment's course and links it to the assignment", async () => {
    const { service, files, assignments } = build();

    const result = await service.createFileUpload("u1", "c1", "a1", { ...request, docType: "assignment" });

    expect(files.createUpload).toHaveBeenCalledWith("u1", "c1", { ...request, docType: "assignment" });
    expect(assignments.addFile).toHaveBeenCalledWith(ref, "f-new");
    expect(result).toEqual(upload);
  });

  it("checks the assignment exists first, and registers nothing if it does not", async () => {
    const { service, assignments, files } = build();
    assignments.get.mockResolvedValue(undefined);

    await expect(service.createFileUpload("u1", "c1", "a9", request)).rejects.toThrow(AssignmentNotFoundError);

    expect(files.createUpload).not.toHaveBeenCalled();
    expect(assignments.addFile).not.toHaveBeenCalled();
  });

  it("registers nothing for a soft-deleted assignment", async () => {
    const { service, assignments, files } = build();
    assignments.get.mockResolvedValue(deletedAssignment());

    await expect(service.createFileUpload("u1", "c1", "a1", request)).rejects.toThrow(AssignmentNotFoundError);

    expect(files.createUpload).not.toHaveBeenCalled();
    expect(assignments.addFile).not.toHaveBeenCalled();
  });

  it("defaults a PDF to the assignment docType", async () => {
    const { service, files } = build();

    await service.createFileUpload("u1", "c1", "a1", request);

    expect(files.createUpload.mock.calls[0][2].docType).toBe("assignment");
  });

  it("defaults an image to the image docType", async () => {
    const { service, files } = build();

    await service.createFileUpload("u1", "c1", "a1", { filename: "board.png", mimeType: "image/png", sizeBytes: 1024 });

    expect(files.createUpload.mock.calls[0][2].docType).toBe("image");
  });

  it("keeps a docType the caller gave", async () => {
    const { service, files } = build();

    await service.createFileUpload("u1", "c1", "a1", { ...request, docType: "syllabus" });

    expect(files.createUpload.mock.calls[0][2].docType).toBe("syllabus");
  });

  it("passes the title through", async () => {
    const { service, files } = build();

    await service.createFileUpload("u1", "c1", "a1", { ...request, title: "Lab 2 handout" });

    expect(files.createUpload.mock.calls[0][2].title).toBe("Lab 2 handout");
  });

  it("does not link anything when the upload is refused, and lets the reason through", async () => {
    const { service, files, assignments } = build();
    files.createUpload.mockRejectedValue(new InvalidUploadError("File is too large"));

    await expect(service.createFileUpload("u1", "c1", "a1", request)).rejects.toThrow("File is too large");

    expect(assignments.addFile).not.toHaveBeenCalled();
  });

  it("throws AssignmentNotFoundError when the assignment disappears before the file is linked", async () => {
    const { service, assignments } = build();
    assignments.addFile.mockResolvedValue(false);

    await expect(service.createFileUpload("u1", "c1", "a1", request)).rejects.toThrow(AssignmentNotFoundError);
  });
});
