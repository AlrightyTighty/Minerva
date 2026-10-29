import type { Assignment, Course, CourseFile, Message, Thread, UserProfile, WorkPlan } from "../models/items.js";

// Response shapes are explicit picks, so a new internal field (S3 keys, hashes, ARNs) can never leak by accident.

export function toUserResponse(user: UserProfile) {
  return {
    userId: user.userId,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    // users created before the field existed have none stored, which means the same as null
    studyPreferences: user.studyPreferences ?? null,
    createdAt: user.createdAt,
  };
}

export function toWorkPlanResponse(plan: WorkPlan) {
  return {
    workPlanId: plan.workPlanId,
    startAt: plan.startAt,
    endAt: plan.endAt,
    timeZone: plan.timeZone,
    workPreferences: plan.workPreferences ?? null,
    items: plan.items.map((item) => ({
      itemId: item.itemId,
      kind: item.kind,
      name: item.name,
      description: item.description,
      startAt: item.startAt,
      endAt: item.endAt,
      assignment: item.assignment ? { courseId: item.assignment.courseId, assignmentId: item.assignment.assignmentId } : null,
      completedAt: item.completedAt ?? null,
    })),
    createdAt: plan.createdAt,
  };
}

export function toCourseResponse(course: Course) {
  return {
    courseId: course.courseId,
    name: course.name,
    createdAt: course.createdAt,
  };
}

export function toAssignmentResponse(assignment: Assignment) {
  return {
    assignmentId: assignment.assignmentId,
    courseId: assignment.courseId,
    title: assignment.title,
    description: assignment.description,
    dueAt: assignment.dueAt,
    fileIds: assignment.fileIds ?? [],
    completedAt: assignment.completedAt ?? null,
    createdAt: assignment.createdAt,
  };
}

export function toThreadResponse(thread: Thread) {
  return {
    threadId: thread.threadId,
    courseId: thread.courseId,
    title: thread.title,
    mode: thread.mode,
    assignmentId: thread.assignmentId,
    turnCount: thread.turnCount,
    pinnedResourceIds: thread.pinnedResourceIds,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

/** Clients only see the text and attachments of a message, never the tool calls or debugging fields. */
export function toMessageResponse(message: Message) {
  return {
    messageId: message.messageId,
    role: message.role,
    turn: message.turn,
    contentBlocks: message.contentBlocks.filter((block) => block.type === "text" || block.type === "resourceRef"),
  };
}

export function toFileResponse(file: CourseFile) {
  return {
    fileId: file.fileId,
    courseId: file.courseId,
    originalFilename: file.originalFilename,
    title: file.title,
    docType: file.docType,
    summary: file.summary,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    status: file.status,
    error: file.error,
    pageCount: file.pageCount,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}
