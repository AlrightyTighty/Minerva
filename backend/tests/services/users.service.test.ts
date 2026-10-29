import { describe, expect, it, vi } from "vitest";
import {
  InvalidProfileError,
  MAX_STUDY_PREFERENCES_CHARS,
  UserNotFoundError,
  UsersService,
} from "../../src/services/users.service.js";

const NOW = new Date("2026-10-26T12:00:00.000Z");

const stored = {
  userId: "u1",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  studyPreferences: null,
  createdAt: "t",
};

// users are created by AuthService.register, together with their login, so this service only reads and edits them
function build() {
  const users = { get: vi.fn(), update: vi.fn() };
  const service = new UsersService({ users, newId: () => "u-new", now: () => NOW } as never);
  return { service, users };
}

describe("UsersService", () => {
  it("no longer creates users itself, since a user cannot exist without a login", () => {
    expect((UsersService.prototype as unknown as Record<string, unknown>).createUser).toBeUndefined();
  });

  it("returns an existing user", async () => {
    const { service, users } = build();
    users.get.mockResolvedValue(stored);

    await expect(service.getUser("u1")).resolves.toEqual(stored);
    expect(users.get).toHaveBeenCalledWith("u1");
  });

  it("throws UserNotFoundError for an unknown user", async () => {
    const { service, users } = build();
    users.get.mockResolvedValue(undefined);

    await expect(service.getUser("nobody")).rejects.toThrow(UserNotFoundError);
  });
});

describe("UsersService.updateProfile: study preferences", () => {
  const set = (service: UsersService, studyPreferences: string | null) =>
    service.updateProfile("u1", { studyPreferences });

  it("allows up to 500 characters", () => {
    expect(MAX_STUDY_PREFERENCES_CHARS).toBe(500);
  });

  it("saves the text and returns the updated user", async () => {
    const { service, users } = build();
    const updated = { ...stored, studyPreferences: "Explain with short examples first." };
    users.update.mockResolvedValue(updated);

    await expect(set(service, "Explain with short examples first.")).resolves.toEqual(updated);

    expect(users.update).toHaveBeenCalledWith("u1", { studyPreferences: "Explain with short examples first." });
  });

  it("trims the text", async () => {
    const { service, users } = build();
    users.update.mockResolvedValue(stored);

    await set(service, "  I like analogies.  \n");

    expect(users.update).toHaveBeenCalledWith("u1", { studyPreferences: "I like analogies." });
  });

  it("keeps line breaks inside the text", async () => {
    const { service, users } = build();
    users.update.mockResolvedValue(stored);

    await set(service, "Short answers.\nThen a quiz question.");

    expect(users.update).toHaveBeenCalledWith("u1", { studyPreferences: "Short answers.\nThen a quiz question." });
  });

  it("clears the preferences with null", async () => {
    const { service, users } = build();
    users.update.mockResolvedValue(stored);

    await set(service, null);

    expect(users.update).toHaveBeenCalledWith("u1", { studyPreferences: null });
  });

  it.each(["", "   ", "\n\t "])("treats the blank text %j as no preferences, and stores null", async (blank) => {
    const { service, users } = build();
    users.update.mockResolvedValue(stored);

    await set(service, blank);

    expect(users.update).toHaveBeenCalledWith("u1", { studyPreferences: null });
  });

  it("accepts exactly 500 characters", async () => {
    const { service, users } = build();
    users.update.mockResolvedValue(stored);

    await expect(set(service, "x".repeat(500))).resolves.toBeDefined();

    expect(users.update).toHaveBeenCalled();
  });

  it("refuses more than 500 characters, and writes nothing", async () => {
    const { service, users } = build();

    await expect(set(service, "x".repeat(501))).rejects.toThrow(InvalidProfileError);

    expect(users.update).not.toHaveBeenCalled();
  });

  it("counts characters as a person does, so 500 emoji fit even though each is two UTF-16 units", async () => {
    const { service, users } = build();
    users.update.mockResolvedValue(stored);

    await expect(set(service, "😀".repeat(500))).resolves.toBeDefined();
    await expect(set(service, "😀".repeat(501))).rejects.toThrow(InvalidProfileError);

    expect(users.update).toHaveBeenCalledTimes(1);
  });

  it("counts the trimmed text, so spaces around 500 characters do not make it too long", async () => {
    const { service, users } = build();
    users.update.mockResolvedValue(stored);

    await expect(set(service, `   ${"x".repeat(500)}   `)).resolves.toBeDefined();
  });

  it("changes nothing else about the user", async () => {
    const { service, users } = build();
    users.update.mockResolvedValue(stored);

    await service.updateProfile("u1", { studyPreferences: "hi", firstName: "Eve", userId: "someone-else" } as never);

    expect(users.update).toHaveBeenCalledWith("u1", { studyPreferences: "hi" });
  });

  it("throws UserNotFoundError for a user that does not exist", async () => {
    const { service, users } = build();
    users.update.mockResolvedValue(undefined);

    await expect(set(service, "hi")).rejects.toThrow(UserNotFoundError);
  });
});
