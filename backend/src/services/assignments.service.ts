import { classifyFilename } from "../models/file-types.js";
import type { Assignment, CourseFile, DocType } from "../models/items.js";
import type { AssignmentEdit, AssignmentRef, AssignmentsRepository } from "../repositories/assignments.repository.js";
import type { CoursesService } from "./courses.service.js";
import type { FilesService, UploadRequest, UploadTarget } from "./files.service.js";
import type { PlanSync } from "./work-plan-sync.service.js";

export class AssignmentNotFoundError extends Error {
  constructor(assignmentId: string) {
    super(`Assignment "${assignmentId}" not found`);
  }
}

export class InvalidAssignmentError extends Error {}

export interface AssignmentsServiceDeps {
  assignments: AssignmentsRepository;
  courses: CoursesService;
  files: FilesService;
  /** Keeps work plans in step when an assignment is completed or reopened. */
  planSync: PlanSync;
  newId: () => string;
  now: () => Date;
}

export interface CreateAssignmentInput {
  title: string;
  description?: string;
  dueAt: string;
}

export interface UpdateAssignmentInput {
  title?: string;
  description?: string;
  dueAt?: string;
  completed?: boolean;
}

export type AssignmentFileRequest = Omit<UploadRequest, "docType"> & { docType?: DocType };

/** Any date the platform can parse is accepted, and stored as UTC so every client reads the same instant. */
function normalizeDueAt(dueAt: string): string {
  const time = Date.parse(dueAt);
  if (Number.isNaN(time)) {
    throw new InvalidAssignmentError("dueAt must be a valid ISO 8601 date or date-time");
  }
  return new Date(time).toISOString();
}

function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new InvalidAssignmentError("title must not be blank");
  }
  return trimmed;
}

const byDueDate = (a: Assignment, b: Assignment) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0);

/**
 * Soft-deleted assignments are gone as far as everything outside this service is concerned. The repository
 * returns them like any other, and this is the one place that decides they do not count.
 */
export class AssignmentsService {
  constructor(private readonly deps: AssignmentsServiceDeps) {}

  async createAssignment(userId: string, courseId: string, input: CreateAssignmentInput): Promise<Assignment> {
    const { assignments, courses, newId, now } = this.deps;

    await courses.getCourse(userId, courseId);
    const title = normalizeTitle(input.title);
    const dueAt = normalizeDueAt(input.dueAt);

    const assignment: Assignment = {
      assignmentId: newId(),
      courseId,
      userId,
      title,
      description: input.description ?? "",
      dueAt,
      fileIds: [],
      completedAt: null,
      createdAt: now().toISOString(),
    };
    if (!(await assignments.create(assignment))) {
      throw new Error(`Assignment id collision for ${assignment.assignmentId}`);
    }
    return assignment;
  }

  /** The course's assignments, soonest due first. */
  async listAssignments(userId: string, courseId: string): Promise<Assignment[]> {
    await this.deps.courses.getCourse(userId, courseId);
    const assignments = await this.deps.assignments.listByCourse(userId, courseId);
    return assignments.filter((assignment) => !assignment.deletedAt).sort(byDueDate);
  }

  /** All of the user's assignments across their courses, soonest due first. */
  async listAllAssignments(userId: string): Promise<Assignment[]> {
    const assignments = await this.deps.assignments.listByUser(userId);
    return assignments.filter((assignment) => !assignment.deletedAt).sort(byDueDate);
  }

  /** Assignments are keyed by user and course, so another user's or course's assignment is simply not found. */
  async getAssignment(userId: string, courseId: string, assignmentId: string): Promise<Assignment> {
    const assignment = await this.deps.assignments.get({ userId, courseId, assignmentId });
    if (!assignment || assignment.deletedAt) {
      throw new AssignmentNotFoundError(assignmentId);
    }
    return assignment;
  }

  /** Edits fields and/or completion. Marking a completed assignment completed again keeps its original time. */
  async updateAssignment(
    userId: string,
    courseId: string,
    assignmentId: string,
    changes: UpdateAssignmentInput,
  ): Promise<Assignment> {
    const { assignments, now } = this.deps;
    const ref: AssignmentRef = { userId, courseId, assignmentId };

    const edit: AssignmentEdit = {};
    if (changes.title !== undefined) edit.title = normalizeTitle(changes.title);
    if (changes.description !== undefined) edit.description = changes.description;
    if (changes.dueAt !== undefined) edit.dueAt = normalizeDueAt(changes.dueAt);
    if (Object.keys(edit).length === 0 && changes.completed === undefined) {
      throw new InvalidAssignmentError("Nothing to update");
    }

    let current = await this.getAssignment(userId, courseId, assignmentId);

    if (Object.keys(edit).length > 0) {
      const updated = await assignments.update(ref, edit);
      if (!updated) {
        throw new AssignmentNotFoundError(assignmentId);
      }
      current = updated;
    }

    if (changes.completed !== undefined && changes.completed !== (current.completedAt !== null)) {
      const updated = await assignments.setCompleted(ref, changes.completed ? now().toISOString() : null);
      if (!updated) {
        throw new AssignmentNotFoundError(assignmentId);
      }
      current = updated;
      await this.syncPlans(current);
    }
    return current;
  }

  /**
   * Completes or reopens an assignment on behalf of a work plan, which already knows. It does not tell the plans,
   * since that would mark every part of the assignment done or open just because one part changed.
   */
  async setCompletionFromPlan(userId: string, courseId: string, assignmentId: string, completed: boolean): Promise<Assignment> {
    const current = await this.getAssignment(userId, courseId, assignmentId);
    if (completed === (current.completedAt !== null)) {
      return current;
    }
    const updated = await this.deps.assignments.setCompleted(
      { userId, courseId, assignmentId },
      completed ? this.deps.now().toISOString() : null,
    );
    if (!updated) {
      throw new AssignmentNotFoundError(assignmentId);
    }
    return updated;
  }

  /** Best effort: the assignment is already saved, so a plan that could not be updated must not fail the request. */
  private async syncPlans(assignment: Assignment): Promise<void> {
    try {
      await this.deps.planSync.syncAssignment(
        assignment.userId,
        { courseId: assignment.courseId, assignmentId: assignment.assignmentId },
        assignment.completedAt,
      );
    } catch (err) {
      console.error(JSON.stringify({ job: "work-plan-sync", error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** Soft-deletes the assignment. Its files stay in the course. */
  async deleteAssignment(userId: string, courseId: string, assignmentId: string): Promise<void> {
    await this.getAssignment(userId, courseId, assignmentId);
    const deleted = await this.deps.assignments.softDelete({ userId, courseId, assignmentId }, this.deps.now().toISOString());
    if (!deleted) {
      throw new AssignmentNotFoundError(assignmentId);
    }
  }

  /** Registers a file in the assignment's course and links it to the assignment. */
  async createFileUpload(
    userId: string,
    courseId: string,
    assignmentId: string,
    request: AssignmentFileRequest,
  ): Promise<{ file: CourseFile; upload: UploadTarget }> {
    await this.getAssignment(userId, courseId, assignmentId);

    // an assignment's files are assignment material, unless they are images
    const docType: DocType = request.docType ?? (classifyFilename(request.filename)?.kind === "image" ? "image" : "assignment");
    const result = await this.deps.files.createUpload(userId, courseId, { ...request, docType });

    // the file exists in the course either way, so if the assignment vanished meanwhile it is simply not linked
    if (!(await this.deps.assignments.addFile({ userId, courseId, assignmentId }, result.file.fileId))) {
      throw new AssignmentNotFoundError(assignmentId);
    }
    return result;
  }
}
