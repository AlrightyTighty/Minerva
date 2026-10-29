import type { CourseFile, Thread } from "../models/items.js";

/** How many tokens of file text are put in front of the model without it asking. */
export const HYDRATION_BUDGET_TOKENS = 20_000;

export interface HydrationPlan {
  /** Files whose Markdown goes into the prompt, in a stable order. */
  documents: CourseFile[];
  /** Image files to attach to the message. They do not count against the token budget. */
  images: CourseFile[];
}

export interface HydrationInput {
  /** Every file in the course, in any state. */
  files: CourseFile[];
  attachmentIds: string[];
  thread: Pick<Thread, "pinnedResourceIds" | "activeResources">;
  /** The turn being answered. */
  turn: number;
  budgetTokens?: number;
}

const isUsable = (file: CourseFile | undefined): file is CourseFile =>
  file !== undefined && file.status === "ready" && !file.deletedAt;

/**
 * Decides which files go in front of the model, deterministically.
 *
 * Attachments always go in. Pinned files and still-active files go in only if they fit in what is left
 * of the budget, in that order of priority. Search-only files (textbooks) are never included.
 * Images go in only for the turn they are attached, or when pinned.
 * The result is ordered by file id so the prompt prefix stays the same between turns and can be cached.
 */
export function planHydration(input: HydrationInput): HydrationPlan {
  const { files, attachmentIds, thread, turn } = input;
  const byId = new Map(files.map((file) => [file.fileId, file]));
  const lookup = (fileId: string) => {
    const file = byId.get(fileId);
    return isUsable(file) ? file : undefined;
  };

  const documents = new Map<string, CourseFile>();
  const images = new Map<string, CourseFile>();
  let remaining = input.budgetTokens ?? HYDRATION_BUDGET_TOKENS;

  const add = (file: CourseFile, mustInclude: boolean) => {
    if (file.docType === "image") {
      images.set(file.fileId, file);
      return;
    }
    if (file.searchOnly || documents.has(file.fileId)) {
      return;
    }
    const tokens = file.tokenCount;
    if (!mustInclude && (tokens === undefined || tokens > remaining)) {
      return;
    }
    documents.set(file.fileId, file);
    remaining -= tokens ?? 0;
  };

  for (const fileId of attachmentIds) {
    const file = lookup(fileId);
    if (file) add(file, true);
  }
  for (const fileId of thread.pinnedResourceIds) {
    const file = lookup(fileId);
    if (file) add(file, false);
  }
  for (const [fileId, active] of Object.entries(thread.activeResources)) {
    const file = lookup(fileId);
    // an image from an earlier turn is not brought back just because it is still "active"
    if (file && file.docType !== "image" && active.expiresAfterTurn >= turn) add(file, false);
  }

  const byFileId = (a: CourseFile, b: CourseFile) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0);
  return {
    documents: [...documents.values()].sort(byFileId),
    images: [...images.values()].sort(byFileId),
  };
}
