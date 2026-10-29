export interface FileRef {
  userId: string;
  courseId: string;
  fileId: string;
}

/** How a person signs in. Kept apart from the profile, so reading a profile can never hand out a password hash. */
export interface LoginRecord {
  /** Lowercase. */
  email: string;
  userId: string;
  /** scrypt, with its settings and salt: never the password. */
  passwordHash: string;
  /** Wrong passwords since the last good sign-in. */
  failedAttempts: number;
  /** While this is in the future, the account refuses sign-in. */
  lockedUntil?: string;
  createdAt: string;
}

/**
 * One refresh token. Each is used once and replaced, and the chain of replacements is a "family": one sign-in on one
 * device. Only a hash of the secret is stored.
 */
export interface RefreshTokenRecord {
  tokenId: string;
  userId: string;
  familyId: string;
  /** SHA-256 of the secret part of the token the client holds. */
  secretHash: string;
  expiresAt: string;
  /** Set when it was swapped for a new token. Using it again later means someone else has a copy. */
  usedAt?: string;
  revokedAt?: string;
  createdAt: string;
  /** Epoch seconds, a little after `expiresAt`, for the table's TTL to clear it. */
  ttl: number;
}

export interface UserProfile {
  userId: string;
  /** Lowercase. */
  email: string;
  firstName: string;
  lastName: string;
  /**
   * How the student likes things explained and how they like to study, in their own words (at most 500
   * characters). Goes into the system prompt of every conversation. Null when they have none, and missing on
   * users created before the field existed, which means the same.
   */
  studyPreferences?: string | null;
  createdAt: string;
}

export interface Course {
  courseId: string;
  userId: string;
  name: string;
  createdAt: string;
  deletedAt?: string;
}

export interface Assignment {
  assignmentId: string;
  courseId: string;
  userId: string;
  title: string;
  description: string;
  dueAt: string;
  /** Uploaded files that belong to this assignment (handout, rubric, ...). */
  fileIds?: string[];
  /** When the student finished the assignment. Null until then. */
  completedAt: string | null;
  createdAt: string;
  /** Soft delete: set instead of removing the item. The service layer treats a deleted assignment as gone. */
  deletedAt?: string;
}

/** One block of a work plan: a stretch of work, or a break. Items live inside their plan and are never stored on their own. */
export interface WorkPlanItem {
  /** Stable, so an item can be addressed after the list changes. */
  itemId: string;
  kind: "work" | "break";
  /** For example "Lab 2 (part 1 of 3)". */
  name: string;
  description: string;
  /** The scheduled block, in UTC. `endAt` is when it should be finished by. */
  startAt: string;
  endAt: string;
  /** The assignment this works on. Null for breaks, and for work that is not an assignment. */
  assignment: { courseId: string; assignmentId: string } | null;
  /** Always null for a break. */
  completedAt: string | null;
}

/** An AI-made schedule for some of the student's assignments, over a window of time. */
export interface WorkPlan {
  workPlanId: string;
  userId: string;
  /** The window the plan covers, in UTC. */
  startAt: string;
  endAt: string;
  /** The IANA time zone the student asked for the plan in. Not kept on the profile, since it changes. */
  timeZone: string;
  /** What the student asked for this plan specifically. */
  workPreferences: string | null;
  /** In time order. */
  items: WorkPlanItem[];
  createdAt: string;
  /** Soft delete: set instead of removing the plan. The service layer treats a deleted plan as gone. */
  deletedAt?: string;
}

export type DocType = "assignment" | "syllabus" | "textbook" | "notes" | "image";

export type FileStatus = "uploaded" | "parsing" | "ingesting" | "ready" | "failed";

export interface CourseFile {
  fileId: string;
  userId: string;
  courseId: string;
  originalFilename: string;
  title: string;
  docType: DocType;
  /** Filled after processing; drives the model's relevance decisions. */
  summary?: string;
  rawKey: string;
  mimeType: string;
  sizeBytes: number;
  contentHash?: string;
  markdownKey?: string;
  /** S3 prefix of the file's KB source objects, for re-ingest and soft delete. */
  kbPrefix?: string;
  status: FileStatus;
  error?: string;
  bdaInvocationArn?: string;
  pageCount?: number;
  tokenCount?: number;
  searchOnly?: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export type ThreadMode = "assignment_help" | "exam_prep" | "concept_review";

export interface ActiveResource {
  loadedAtTurn: number;
  expiresAfterTurn: number;
}

export interface Thread {
  threadId: string;
  courseId: string;
  userId: string;
  title: string;
  mode: ThreadMode;
  assignmentId?: string;
  turnCount: number;
  /** Always hydrated when small. */
  pinnedResourceIds: string[];
  activeResources: Record<string, ActiveResource>;
  summary?: string;
  summaryThrough?: number;
  createdAt: string;
  updatedAt: string;
  /** Soft delete: set instead of removing the thread or its messages. */
  deletedAt?: string;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resourceRef"; resourceId: string }
  | { type: "toolCall"; toolUseId: string; name: string; input: object }
  | { type: "toolResultRef"; toolUseId: string; resourceId?: string; summary: string };

export interface Message {
  messageId: string;
  role: "user" | "assistant";
  turn: number;
  contentBlocks: ContentBlock[];
  hydratedResourceIds: string[];
  /** Epoch seconds. The table's TTL attribute is "ttl". */
  ttl?: number;
}

/**
 * Global record per distinct file content, used to run BDA at most once per document.
 * Not tied to any user: the processed Markdown is copied into each uploader's own paths.
 */
export interface ProcessedHash {
  contentHash: string;
  status: "parsing" | "complete";
  /** Set once complete: the first uploader's processed Markdown. */
  markdownKey?: string;
  pageCount?: number;
  /** Files with the same content that arrived while the first one was still parsing. */
  waiters: FileRef[];
  createdAt: string;
  updatedAt: string;
  /** Epoch seconds. Only set while parsing, so a crashed claim eventually expires. */
  ttl?: number;
}
