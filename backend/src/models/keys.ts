import type { FileRef } from "./items.js";

// DynamoDB keys. Type-first sort keys, so each access pattern is a single begins_with query:
//   a user's courses              PK=USER#u, begins_with(SK, "COURSE#")
//   a user's / course's files     PK=USER#u, begins_with(SK, "FILE#") / "FILE#<courseId>#"
//   a user's / course's threads   PK=USER#u, begins_with(SK, "THREAD#") / "THREAD#<courseId>#"
//   a user's / course's assignments  likewise with "ASSIGNMENT#"
//   recent messages               PK=THREAD#t, ScanIndexForward=false

/** IDs go into keys with "#" as the separator, so they can never contain one. */
export function assertKeyId(id: string): string {
  if (!id || id.includes("#") || id.includes("/")) {
    throw new Error(`Invalid id "${id}": must be non-empty and contain no "#" or "/"`);
  }
  return id;
}

export const userPk = (userId: string) => `USER#${assertKeyId(userId)}`;
export const profileSk = () => "PROFILE";

// A login is keyed by email, which is how a person signs in. The service lowercases emails before they get here,
// and the key refuses anything that has not been, so two spellings of one email can never be two accounts.
export const loginPk = (email: string) => {
  if (!email || email !== email.toLowerCase()) {
    throw new Error("A login key needs a non-empty, lowercase email");
  }
  return `EMAIL#${email}`;
};
export const loginSk = () => "LOGIN";

export const REFRESH_PREFIX = "REFRESH#";
export const refreshSk = (tokenId: string) => `${REFRESH_PREFIX}${assertKeyId(tokenId)}`;
export const courseSk = (courseId: string) => `COURSE#${assertKeyId(courseId)}`;
export const fileSk = (courseId: string, fileId: string) =>
  `FILE#${assertKeyId(courseId)}#${assertKeyId(fileId)}`;
export const threadSk = (courseId: string, threadId: string) =>
  `THREAD#${assertKeyId(courseId)}#${assertKeyId(threadId)}`;
export const assignmentSk = (courseId: string, assignmentId: string) =>
  `ASSIGNMENT#${assertKeyId(courseId)}#${assertKeyId(assignmentId)}`;

export const COURSE_PREFIX = "COURSE#";
export const FILE_PREFIX = "FILE#";
export const THREAD_PREFIX = "THREAD#";
export const ASSIGNMENT_PREFIX = "ASSIGNMENT#";
// a work plan spans courses, so it is keyed by user alone
export const WORKPLAN_PREFIX = "WORKPLAN#";
export const workPlanSk = (workPlanId: string) => `${WORKPLAN_PREFIX}${assertKeyId(workPlanId)}`;
export const courseFilesPrefix = (courseId: string) => `${FILE_PREFIX}${assertKeyId(courseId)}#`;
export const courseThreadsPrefix = (courseId: string) => `${THREAD_PREFIX}${assertKeyId(courseId)}#`;
export const courseAssignmentsPrefix = (courseId: string) => `${ASSIGNMENT_PREFIX}${assertKeyId(courseId)}#`;

export const threadPk = (threadId: string) => `THREAD#${assertKeyId(threadId)}`;
export const MESSAGE_PREFIX = "MESSAGE#";
export const messageSk = (messageId: string) => `${MESSAGE_PREFIX}${assertKeyId(messageId)}`;

export const hashPk = (contentHash: string) => `HASH#${assertKeyId(contentHash)}`;
export const hashSk = () => "PROCESSED";

// S3 keys. The IDs are encoded in every path, so any Lambda can find the DynamoDB item from a key alone.
//   raw/{userId}/{courseId}/{fileId}/original.pdf
//   bda-output/{userId}/{courseId}/{fileId}/...
//   processed/{userId}/{courseId}/{fileId}/full.md
//   kb-source/{userId}/{courseId}/{fileId}/part-01.md  (+ part-01.md.metadata.json)

const idPath = (ref: FileRef) =>
  `${assertKeyId(ref.userId)}/${assertKeyId(ref.courseId)}/${assertKeyId(ref.fileId)}`;

export const rawKey = (ref: FileRef, filename: string) => `raw/${idPath(ref)}/${filename}`;
export const bdaOutputPrefix = (ref: FileRef) => `bda-output/${idPath(ref)}/`;
export const processedKey = (ref: FileRef) => `processed/${idPath(ref)}/full.md`;
export const kbPrefix = (ref: FileRef) => `kb-source/${idPath(ref)}/`;
export const kbPartKey = (ref: FileRef, part: number) =>
  `${kbPrefix(ref)}part-${String(part).padStart(2, "0")}.md`;
export const sidecarKey = (sourceKey: string) => `${sourceKey}.metadata.json`;

const KEYED_PREFIXES = ["raw", "bda-output", "processed", "kb-source"];

/** Parses `<prefix>/{userId}/{courseId}/{fileId}/<rest>` for any of the pipeline prefixes. */
export function parseS3Key(key: string): { ref: FileRef; rest: string } | undefined {
  const [prefix, userId, courseId, fileId, ...rest] = key.split("/");
  if (!KEYED_PREFIXES.includes(prefix) || !userId || !courseId || !fileId || rest.length === 0) {
    return undefined;
  }
  return { ref: { userId, courseId, fileId }, rest: rest.join("/") };
}

/** Parses a `raw/` key. Returns the original filename (e.g. "original.pdf"). */
export function parseRawKey(key: string): { ref: FileRef; filename: string } | undefined {
  if (!key.startsWith("raw/")) {
    return undefined;
  }
  const parsed = parseS3Key(key);
  return parsed ? { ref: parsed.ref, filename: parsed.rest } : undefined;
}
