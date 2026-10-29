import { describe, expect, it } from "vitest";
import {
  AccountLockedError,
  EmailTakenError,
  IncorrectPasswordError,
  InvalidAuthRequestError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
} from "../../src/services/auth.service.js";
import { AUTH, USER, buildTestApp } from "../support/test-app.js";

// the user the API shows. The password hash, the lockout state and refresh tokens are never part of it.
const userResponse = { ...USER };
const tokens = { accessToken: "access.jwt.here", refreshToken: "u1.t1.secret", expiresIn: 900 };

const post = (app: ReturnType<typeof buildTestApp>["app"], url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });

describe("POST /auth/register", () => {
  const body = { email: "ada@example.com", password: "good-password-1", firstName: "Ada", lastName: "Lovelace" };

  it("creates an account and signs the new user in", async () => {
    const { app, services } = buildTestApp();
    services.auth.register.mockResolvedValue({ user: USER, tokens });

    const response = await post(app, "/auth/register", body);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ user: userResponse, ...tokens });
    expect(services.auth.register).toHaveBeenCalledWith(body);
  });

  it("needs no token", async () => {
    const { app, services } = buildTestApp();
    services.auth.register.mockResolvedValue({ user: USER, tokens });

    const response = await post(app, "/auth/register", body);

    expect(response.statusCode).toBe(201);
    expect(services.tokens.verify).not.toHaveBeenCalled();
  });

  it("ignores fields it does not know, so nobody can register with another user's id or set their own preferences", async () => {
    const { app, services } = buildTestApp();
    services.auth.register.mockResolvedValue({ user: USER, tokens });

    await post(app, "/auth/register", { ...body, userId: "u9", studyPreferences: "x", failedAttempts: 0, passwordHash: "x" });

    expect(services.auth.register).toHaveBeenCalledWith(body);
  });

  it("never includes anything secret in the response", async () => {
    const { app, services } = buildTestApp();
    services.auth.register.mockResolvedValue({
      user: { ...USER, passwordHash: "scrypt$secret", failedAttempts: 2, lockedUntil: "t" },
      tokens,
    });

    const response = await post(app, "/auth/register", body);

    expect(JSON.stringify(response.json())).not.toMatch(/passwordHash|scrypt|failedAttempts|lockedUntil/);
  });

  it.each([
    ["no email", { ...body, email: undefined }],
    ["no password", { ...body, password: undefined }],
    ["no first name", { ...body, firstName: undefined }],
    ["no last name", { ...body, lastName: undefined }],
    ["an email that is not text", { ...body, email: 42 }],
    ["a password that is not text", { ...body, password: 1234567890 }],
    ["an email over 254 characters", { ...body, email: `${"a".repeat(250)}@example.com` }],
    ["a password over 128 characters, which would make hashing expensive", { ...body, password: "x".repeat(129) }],
    ["a name over 100 characters", { ...body, firstName: "x".repeat(101) }],
  ])("rejects %s with 400, before it reaches the service", async (_label, payload) => {
    const { app, services } = buildTestApp();

    const response = await post(app, "/auth/register", payload);

    expect(response.statusCode).toBe(400);
    expect(services.auth.register).not.toHaveBeenCalled();
  });

  it("returns 400 with the reason when the service refuses the details", async () => {
    const { app, services } = buildTestApp();
    services.auth.register.mockRejectedValue(new InvalidAuthRequestError("Password must be at least 10 characters"));

    const response = await post(app, "/auth/register", body);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "Password must be at least 10 characters" });
  });

  it("returns 409 when the email already has an account", async () => {
    const { app, services } = buildTestApp();
    services.auth.register.mockRejectedValue(new EmailTakenError());

    const response = await post(app, "/auth/register", body);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ message: "An account with this email already exists" });
  });
});

describe("POST /auth/login", () => {
  const body = { email: "ada@example.com", password: "good-password-1" };

  it("signs in and returns the user with a new session", async () => {
    const { app, services } = buildTestApp();
    services.auth.login.mockResolvedValue({ user: USER, tokens });

    const response = await post(app, "/auth/login", body);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: userResponse, ...tokens });
    expect(services.auth.login).toHaveBeenCalledWith(body);
  });

  it("does not hold a password to the length rules, so an old short one can still be refused with the usual message", async () => {
    const { app, services } = buildTestApp();
    services.auth.login.mockRejectedValue(new InvalidCredentialsError());

    const response = await post(app, "/auth/login", { email: "ada@example.com", password: "short" });

    expect(response.statusCode).toBe(401);
  });

  it.each([
    ["no email", { password: "x" }],
    ["no password", { email: "ada@example.com" }],
    ["a password that is not text", { email: "ada@example.com", password: 5 }],
    ["a password over 128 characters", { email: "ada@example.com", password: "x".repeat(129) }],
  ])("rejects %s with 400", async (_label, payload) => {
    const { app, services } = buildTestApp();

    const response = await post(app, "/auth/login", payload);

    expect(response.statusCode).toBe(400);
    expect(services.auth.login).not.toHaveBeenCalled();
  });

  it("returns 401 with one fixed message for a wrong password and an unknown email alike", async () => {
    const { app, services } = buildTestApp();
    services.auth.login.mockRejectedValue(new InvalidCredentialsError());

    const response = await post(app, "/auth/login", body);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ message: "Incorrect email or password" });
  });

  it("returns 429 for a locked account, with how many seconds to wait in the standard header and in the body", async () => {
    const { app, services } = buildTestApp();
    services.auth.login.mockRejectedValue(new AccountLockedError(600));

    const response = await post(app, "/auth/login", body);

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("600");
    expect(response.json()).toEqual({ message: "Too many failed attempts. Try again later.", retryAfterSeconds: 600 });
  });
});

describe("POST /auth/refresh", () => {
  it("swaps a refresh token for a new access token and a new refresh token", async () => {
    const { app, services } = buildTestApp();
    services.auth.refresh.mockResolvedValue(tokens);

    const response = await post(app, "/auth/refresh", { refreshToken: "u1.t0.old" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(tokens);
    expect(services.auth.refresh).toHaveBeenCalledWith("u1.t0.old");
  });

  it("needs no access token, since the access token is what has just expired", async () => {
    const { app, services } = buildTestApp();
    services.auth.refresh.mockResolvedValue(tokens);

    const response = await post(app, "/auth/refresh", { refreshToken: "u1.t0.old" }, { authorization: "Bearer expired.jwt.token" });

    expect(response.statusCode).toBe(200);
  });

  it.each([
    ["no refresh token", {}],
    ["a refresh token that is not text", { refreshToken: 5 }],
    ["an empty refresh token", { refreshToken: "" }],
    ["an absurdly long refresh token", { refreshToken: "x".repeat(1025) }],
  ])("rejects %s with 400", async (_label, payload) => {
    const { app, services } = buildTestApp();

    const response = await post(app, "/auth/refresh", payload);

    expect(response.statusCode).toBe(400);
    expect(services.auth.refresh).not.toHaveBeenCalled();
  });

  it("returns 401, with one fixed message, for any refresh token that cannot be used", async () => {
    const { app, services } = buildTestApp();
    services.auth.refresh.mockRejectedValue(new InvalidRefreshTokenError());

    const response = await post(app, "/auth/refresh", { refreshToken: "u1.t0.old" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ message: "Invalid or expired refresh token" });
  });
});

describe("POST /auth/logout", () => {
  it("ends the session the refresh token belongs to, and returns nothing", async () => {
    const { app, services } = buildTestApp();
    services.auth.logout.mockResolvedValue(undefined);

    const response = await post(app, "/auth/logout", { refreshToken: "u1.t1.secret" });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(services.auth.logout).toHaveBeenCalledWith("u1.t1.secret");
  });

  it("works with an expired access token, or none, since a person must be able to sign out", async () => {
    const { app, services } = buildTestApp();
    services.auth.logout.mockResolvedValue(undefined);

    expect((await post(app, "/auth/logout", { refreshToken: "u1.t1.secret" })).statusCode).toBe(204);
    expect(
      (await post(app, "/auth/logout", { refreshToken: "u1.t1.secret" }, { authorization: "Bearer expired" })).statusCode,
    ).toBe(204);
  });

  it("returns 400 without a refresh token", async () => {
    const { app, services } = buildTestApp();

    const response = await post(app, "/auth/logout", {});

    expect(response.statusCode).toBe(400);
    expect(services.auth.logout).not.toHaveBeenCalled();
  });
});

describe("POST /auth/change-password", () => {
  const body = { currentPassword: "good-password-1", newPassword: "brand-new-password" };

  it("changes the signed-in user's password, and returns a new session for this device since every other one is signed out", async () => {
    const { app, services } = buildTestApp();
    services.auth.changePassword.mockResolvedValue(tokens);

    const response = await post(app, "/auth/change-password", body, AUTH);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(tokens);
    expect(services.auth.changePassword).toHaveBeenCalledWith("u1", body);
  });

  it("changes the password of the user in the token, whatever else is sent", async () => {
    const { app, services } = buildTestApp();
    services.auth.changePassword.mockResolvedValue(tokens);

    await post(app, "/auth/change-password", { ...body, userId: "someone-else", email: "victim@example.com" }, AUTH);

    expect(services.auth.changePassword).toHaveBeenCalledWith("u1", body);
  });

  it.each([
    ["no current password", { newPassword: "brand-new-password" }],
    ["no new password", { currentPassword: "good-password-1" }],
    ["a new password over 128 characters", { ...body, newPassword: "x".repeat(129) }],
    ["a password that is not text", { ...body, newPassword: 12345678901 }],
  ])("rejects %s with 400", async (_label, payload) => {
    const { app, services } = buildTestApp();

    const response = await post(app, "/auth/change-password", payload, AUTH);

    expect(response.statusCode).toBe(400);
    expect(services.auth.changePassword).not.toHaveBeenCalled();
  });

  it("returns 400 with the reason when the new password is not acceptable", async () => {
    const { app, services } = buildTestApp();
    services.auth.changePassword.mockRejectedValue(new InvalidAuthRequestError("Password must be at least 10 characters"));

    const response = await post(app, "/auth/change-password", body, AUTH);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "Password must be at least 10 characters" });
  });

  it("returns 403, not 401, when the current password is wrong, so a client does not mistake it for an expired session", async () => {
    const { app, services } = buildTestApp();
    services.auth.changePassword.mockRejectedValue(new IncorrectPasswordError());

    const response = await post(app, "/auth/change-password", body, AUTH);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ message: "Current password is incorrect" });
  });

  it("returns 429 when too many wrong guesses have locked the account", async () => {
    const { app, services } = buildTestApp();
    services.auth.changePassword.mockRejectedValue(new AccountLockedError(120));

    const response = await post(app, "/auth/change-password", body, AUTH);

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("120");
  });
});
