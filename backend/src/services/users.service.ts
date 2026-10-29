import type { UserProfile } from "../models/items.js";
import type { UsersRepository } from "../repositories/users.repository.js";

export class UserNotFoundError extends Error {
  constructor(userId: string) {
    super(`User "${userId}" not found`);
  }
}

export class InvalidProfileError extends Error {}

/** The most a student can write about how they like to study. It goes into every conversation, so it stays short. */
export const MAX_STUDY_PREFERENCES_CHARS = 500;

export interface UsersServiceDeps {
  users: UsersRepository;
  newId: () => string;
  now: () => Date;
}

export interface ProfileChanges {
  studyPreferences?: string | null;
}

/** Trims the text, and treats blank as none. The limit counts characters as a person does, not UTF-16 units. */
function normalizeStudyPreferences(text: string | null): string | null {
  const trimmed = text?.trim() ?? "";
  if (trimmed === "") {
    return null;
  }
  if (Array.from(trimmed).length > MAX_STUDY_PREFERENCES_CHARS) {
    throw new InvalidProfileError(`studyPreferences must be at most ${MAX_STUDY_PREFERENCES_CHARS} characters`);
  }
  return trimmed;
}

export class UsersService {
  constructor(private readonly deps: UsersServiceDeps) {}

  async getUser(userId: string): Promise<UserProfile> {
    const user = await this.deps.users.get(userId);
    if (!user) {
      throw new UserNotFoundError(userId);
    }
    return user;
  }

  /** Changes the profile fields a student can edit themselves. Anything else in `changes` is ignored. */
  async updateProfile(userId: string, changes: ProfileChanges): Promise<UserProfile> {
    if (changes.studyPreferences === undefined) {
      throw new InvalidProfileError("Nothing to update");
    }
    const updated = await this.deps.users.update(userId, {
      studyPreferences: normalizeStudyPreferences(changes.studyPreferences),
    });
    if (!updated) {
      throw new UserNotFoundError(userId);
    }
    return updated;
  }
}
