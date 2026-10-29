import { describe, expect, it } from "vitest";
import { InvalidProfileError } from "../../src/services/users.service.js";
import { AUTH, USER, buildTestApp } from "../support/test-app.js";

describe("GET /users/me", () => {
  it("returns the caller's profile, including their study preferences", async () => {
    const { app, services } = buildTestApp();
    services.users.getUser.mockResolvedValue({ ...USER, studyPreferences: "Short examples first." });

    const response = await app.inject({ method: "GET", url: "/users/me", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...USER, studyPreferences: "Short examples first." });
    expect(services.users.getUser).toHaveBeenCalledWith("u1");
  });

  it("shows null for a user who has never set study preferences, including users created before the field existed", async () => {
    const { app, services } = buildTestApp();
    const { studyPreferences: _omitted, ...oldUser } = USER;
    services.users.getUser.mockResolvedValue(oldUser);

    const response = await app.inject({ method: "GET", url: "/users/me", headers: AUTH });

    expect(response.json()).toHaveProperty("studyPreferences", null);
  });
});

describe("PATCH /users/me", () => {
  const patch = (app: ReturnType<typeof buildTestApp>["app"], payload: unknown) =>
    app.inject({ method: "PATCH", url: "/users/me", headers: AUTH, payload: payload as object });

  it("sets the caller's study preferences and returns the updated profile", async () => {
    const { app, services } = buildTestApp();
    services.users.updateProfile.mockResolvedValue({ ...USER, studyPreferences: "Short examples first." });

    const response = await patch(app, { studyPreferences: "Short examples first." });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...USER, studyPreferences: "Short examples first." });
    expect(services.users.updateProfile).toHaveBeenCalledWith("u1", { studyPreferences: "Short examples first." });
  });

  it("clears them with null", async () => {
    const { app, services } = buildTestApp();
    services.users.updateProfile.mockResolvedValue(USER);

    const response = await patch(app, { studyPreferences: null });

    expect(response.statusCode).toBe(200);
    expect(response.json().studyPreferences).toBeNull();
    expect(services.users.updateProfile).toHaveBeenCalledWith("u1", { studyPreferences: null });
  });

  it("accepts exactly 500 characters", async () => {
    const { app, services } = buildTestApp();
    services.users.updateProfile.mockResolvedValue(USER);

    const response = await patch(app, { studyPreferences: "x".repeat(500) });

    expect(response.statusCode).toBe(200);
  });

  it("counts characters as a person does, so 500 emoji are accepted and 501 are not", async () => {
    const { app, services } = buildTestApp();
    services.users.updateProfile.mockResolvedValue(USER);

    expect((await patch(app, { studyPreferences: "😀".repeat(500) })).statusCode).toBe(200);
    expect((await patch(app, { studyPreferences: "😀".repeat(501) })).statusCode).toBe(400);
  });

  it.each([
    ["more than 500 characters", { studyPreferences: "x".repeat(501) }],
    ["no fields", {}],
    ["a number", { studyPreferences: 42 }],
    ["a list", { studyPreferences: ["short examples"] }],
  ])("rejects %s with 400", async (_label, payload) => {
    const { app, services } = buildTestApp();

    const response = await patch(app, payload);

    expect(response.statusCode).toBe(400);
    expect(services.users.updateProfile).not.toHaveBeenCalled();
  });

  it("changes only the caller's study preferences, whatever else is sent", async () => {
    const { app, services } = buildTestApp();
    services.users.updateProfile.mockResolvedValue(USER);

    await patch(app, { studyPreferences: "hi", firstName: "Eve", userId: "someone-else" });

    expect(services.users.updateProfile).toHaveBeenCalledWith("u1", { studyPreferences: "hi" });
  });

  it("returns 400 with the reason when the service refuses the text", async () => {
    const { app, services } = buildTestApp();
    services.users.updateProfile.mockRejectedValue(new InvalidProfileError("studyPreferences must be at most 500 characters"));

    const response = await patch(app, { studyPreferences: "hi" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "studyPreferences must be at most 500 characters" });
  });
});
