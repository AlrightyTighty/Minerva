import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { LoginRecord, RefreshTokenRecord, UserProfile } from "../../src/models/items.js";
import {
  AccountLockedError,
  AuthService,
  EmailTakenError,
  IncorrectPasswordError,
  InvalidAuthRequestError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  LOCKOUT_SECONDS,
  MAX_FAILED_LOGINS,
  REFRESH_REUSE_GRACE_SECONDS,
  REFRESH_TOKEN_DAYS,
} from "../../src/services/auth.service.js";

const NOW = new Date("2026-10-28T12:00:00.000Z");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const iso = (secondsFromNow: number) => new Date(NOW.getTime() + secondsFromNow * 1000).toISOString();

const profile: UserProfile = {
  userId: "u1",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  studyPreferences: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};

const loginRecord = (overrides: Partial<LoginRecord> = {}): LoginRecord => ({
  email: "ada@example.com",
  userId: "u1",
  passwordHash: "hash-of-good-password-1",
  failedAttempts: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const tokenRecord = (overrides: Partial<RefreshTokenRecord> = {}): RefreshTokenRecord => ({
  tokenId: "t1",
  userId: "u1",
  familyId: "f1",
  secretHash: sha256("s3cret"),
  expiresAt: iso(86400),
  createdAt: iso(-60),
  ttl: 0,
  ...overrides,
});

/** The refresh token a client would hold for tokenRecord(). */
const TOKEN = "u1.t1.s3cret";

function build() {
  let counter = 0;
  const users = { createWithLogin: vi.fn().mockResolvedValue(true), get: vi.fn().mockResolvedValue(profile) };
  const logins = {
    get: vi.fn().mockResolvedValue(loginRecord()),
    recordFailure: vi.fn().mockResolvedValue(1),
    lock: vi.fn().mockResolvedValue(undefined),
    clearFailures: vi.fn().mockResolvedValue(undefined),
    setPasswordHash: vi.fn().mockResolvedValue(undefined),
  };
  const refreshTokens = {
    create: vi.fn().mockResolvedValue(true),
    get: vi.fn().mockResolvedValue(tokenRecord()),
    markUsed: vi.fn().mockResolvedValue(true),
    revoke: vi.fn().mockResolvedValue(true),
    listByUser: vi.fn().mockResolvedValue([]),
  };
  // the password "good-password-1" is the right one, and verifying anything else is a failure
  const hasher = {
    hash: vi.fn(async (password: string) => `hash-of-${password}`),
    verify: vi.fn(async (password: string, stored: string) => stored === `hash-of-${password}`),
  };
  const tokens = {
    sign: vi.fn(async (userId: string) => ({ token: `access-for-${userId}`, expiresIn: 900 })),
  };
  const service = new AuthService({
    users,
    logins,
    refreshTokens,
    hasher,
    tokens,
    newId: () => `id-${++counter}`,
    randomSecret: () => `secret-${counter}`,
    now: () => NOW,
  } as never);
  return { service, users, logins, refreshTokens, hasher, tokens };
}

const registerInput = {
  email: "Ada@Example.com",
  password: "good-password-1",
  firstName: "Ada",
  lastName: "Lovelace",
};

describe("AuthService.register", () => {
  it("creates the user and a login together, and signs them in", async () => {
    const { service, users } = build();

    const result = await service.register(registerInput);

    expect(users.createWithLogin).toHaveBeenCalledTimes(1);
    const [newUser, newLogin] = users.createWithLogin.mock.calls[0];
    expect(newUser).toEqual({
      userId: "id-1",
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      studyPreferences: null,
      createdAt: NOW.toISOString(),
    });
    expect(newLogin).toEqual({
      email: "ada@example.com",
      userId: "id-1",
      passwordHash: "hash-of-good-password-1",
      failedAttempts: 0,
      createdAt: NOW.toISOString(),
    });
    expect(result.user).toEqual(newUser);
    expect(result.tokens).toEqual({ accessToken: "access-for-id-1", refreshToken: expect.any(String), expiresIn: 900 });
  });

  it("stores only a hash of the password, never the password", async () => {
    const { service, users } = build();

    await service.register(registerInput);

    expect(JSON.stringify(users.createWithLogin.mock.calls[0])).not.toContain('"good-password-1"');
  });

  it("treats emails as case-insensitive and ignores surrounding spaces", async () => {
    const { service, users } = build();

    await service.register({ ...registerInput, email: "  ADA@EXAMPLE.COM \n" });

    expect(users.createWithLogin.mock.calls[0][0].email).toBe("ada@example.com");
    expect(users.createWithLogin.mock.calls[0][1].email).toBe("ada@example.com");
  });

  it("trims the names", async () => {
    const { service, users } = build();

    await service.register({ ...registerInput, firstName: "  Ada ", lastName: " Lovelace  " });

    expect(users.createWithLogin.mock.calls[0][0]).toMatchObject({ firstName: "Ada", lastName: "Lovelace" });
  });

  it("refuses an email that is already registered, and issues nothing", async () => {
    const { service, users, refreshTokens, tokens } = build();
    users.createWithLogin.mockResolvedValue(false);

    await expect(service.register(registerInput)).rejects.toThrow(EmailTakenError);

    expect(refreshTokens.create).not.toHaveBeenCalled();
    expect(tokens.sign).not.toHaveBeenCalled();
  });

  it.each([
    ["no @", "ada.example.com"],
    ["nothing before the @", "@example.com"],
    ["no domain", "ada@"],
    ["a space inside", "ada lovelace@example.com"],
    ["two @ signs", "a@b@example.com"],
    ["a domain with no dot", "ada@localhost"],
    ["nothing", ""],
    ["more than 254 characters", `${"a".repeat(250)}@example.com`],
  ])("rejects an email with %s", async (_label, email) => {
    const { service, users } = build();

    await expect(service.register({ ...registerInput, email })).rejects.toThrow(InvalidAuthRequestError);

    expect(users.createWithLogin).not.toHaveBeenCalled();
  });

  it.each([
    ["shorter than 10 characters", "short-1"],
    ["longer than 128 characters", "x".repeat(129)],
    ["empty", ""],
  ])("rejects a password that is %s, without hashing it", async (_label, password) => {
    const { service, hasher, users } = build();

    await expect(service.register({ ...registerInput, password })).rejects.toThrow(InvalidAuthRequestError);

    expect(hasher.hash).not.toHaveBeenCalled();
    expect(users.createWithLogin).not.toHaveBeenCalled();
  });

  it("counts password characters as a person does, so a 10 character password of emoji is long enough", async () => {
    const { service } = build();

    await expect(service.register({ ...registerInput, password: "😀".repeat(10) })).resolves.toBeDefined();
    await expect(service.register({ ...registerInput, password: "😀".repeat(9) })).rejects.toThrow(InvalidAuthRequestError);
  });

  it("accepts a password of exactly 128 characters, and one made only of spaces if it is long enough", async () => {
    const { service } = build();

    await expect(service.register({ ...registerInput, password: "x".repeat(128) })).resolves.toBeDefined();
    await expect(service.register({ ...registerInput, password: " ".repeat(12) })).resolves.toBeDefined();
  });

  it.each([
    ["a blank first name", { firstName: "  " }],
    ["a blank last name", { lastName: "" }],
    ["a first name over 100 characters", { firstName: "x".repeat(101) }],
  ])("rejects %s", async (_label, overrides) => {
    const { service, users } = build();

    await expect(service.register({ ...registerInput, ...overrides })).rejects.toThrow(InvalidAuthRequestError);

    expect(users.createWithLogin).not.toHaveBeenCalled();
  });
});

describe("AuthService: the session a sign-in starts", () => {
  it("gives the client a refresh token made of the user, a token id and a secret", async () => {
    const { service } = build();

    const { tokens } = await service.login({ email: "ada@example.com", password: "good-password-1" });

    const [userId, tokenId, secret] = tokens.refreshToken.split(".");
    expect(userId).toBe("u1");
    expect(tokenId).toMatch(/^id-/);
    expect(secret).toMatch(/^secret-/);
    expect(tokens.refreshToken.split(".")).toHaveLength(3);
  });

  it("stores only a hash of the secret, so a copy of the database cannot be used to refresh", async () => {
    const { service, refreshTokens } = build();

    const { tokens } = await service.login({ email: "ada@example.com", password: "good-password-1" });

    const secret = tokens.refreshToken.split(".")[2];
    const stored = refreshTokens.create.mock.calls[0][0];
    expect(stored.secretHash).toBe(sha256(secret));
    expect(JSON.stringify(stored)).not.toContain(secret);
  });

  it(`stores the token for ${REFRESH_TOKEN_DAYS} days, and lets the database clear it a little after`, async () => {
    const { service, refreshTokens } = build();

    await service.login({ email: "ada@example.com", password: "good-password-1" });

    const stored = refreshTokens.create.mock.calls[0][0];
    const expires = NOW.getTime() + REFRESH_TOKEN_DAYS * 86400_000;
    expect(stored.expiresAt).toBe(new Date(expires).toISOString());
    expect(stored.ttl).toBeGreaterThan(expires / 1000);
    expect(stored.createdAt).toBe(NOW.toISOString());
    expect(stored.userId).toBe("u1");
  });

  it("gives every sign-in its own session, so one device can be signed out without the others", async () => {
    const { service, refreshTokens } = build();

    await service.login({ email: "ada@example.com", password: "good-password-1" });
    await service.login({ email: "ada@example.com", password: "good-password-1" });

    const families = refreshTokens.create.mock.calls.map((call) => call[0].familyId);
    expect(new Set(families).size).toBe(2);
  });
});

describe("AuthService.login", () => {
  const login = (service: AuthService, password = "good-password-1", email = "ada@example.com") =>
    service.login({ email, password });

  it("signs in with the right password, and returns the user", async () => {
    const { service, logins, users } = build();

    const result = await login(service);

    expect(logins.get).toHaveBeenCalledWith("ada@example.com");
    expect(users.get).toHaveBeenCalledWith("u1");
    expect(result.user).toEqual(profile);
    expect(result.tokens.accessToken).toBe("access-for-u1");
  });

  it("finds the account whatever case the email is typed in", async () => {
    const { service, logins } = build();

    await login(service, "good-password-1", "  ADA@Example.com ");

    expect(logins.get).toHaveBeenCalledWith("ada@example.com");
  });

  it("refuses the wrong password, counts the failure, and issues nothing", async () => {
    const { service, logins, refreshTokens, tokens } = build();

    await expect(login(service, "wrong-password")).rejects.toThrow(InvalidCredentialsError);

    expect(logins.recordFailure).toHaveBeenCalledWith("ada@example.com");
    expect(refreshTokens.create).not.toHaveBeenCalled();
    expect(tokens.sign).not.toHaveBeenCalled();
  });

  it("gives the same error for an unknown email as for a wrong password, so it cannot be used to find who has an account", async () => {
    const { service, logins } = build();
    logins.get.mockResolvedValue(undefined);

    const unknown = await login(service, "good-password-1", "nobody@example.com").catch((e: Error) => e);
    const wrong = await login(build().service, "wrong-password").catch((e: Error) => e);

    expect(unknown).toBeInstanceOf(InvalidCredentialsError);
    expect((unknown as Error).message).toBe((wrong as Error).message);
  });

  it("does the same amount of password work for an unknown email, so the response time does not give it away", async () => {
    const { service, logins, hasher } = build();
    logins.get.mockResolvedValue(undefined);

    await login(service, "whatever-password", "nobody@example.com").catch(() => undefined);

    expect(hasher.verify).toHaveBeenCalledTimes(1);
  });

  it("does not count a failure against an email that has no account", async () => {
    const { service, logins } = build();
    logins.get.mockResolvedValue(undefined);

    await login(service, "x".repeat(12), "nobody@example.com").catch(() => undefined);

    expect(logins.recordFailure).not.toHaveBeenCalled();
    expect(logins.lock).not.toHaveBeenCalled();
  });

  describe("lockout", () => {
    it(`locks the account for ${LOCKOUT_SECONDS / 60} minutes on failure number ${MAX_FAILED_LOGINS}`, async () => {
      const { service, logins } = build();
      logins.recordFailure.mockResolvedValue(MAX_FAILED_LOGINS);

      await expect(login(service, "wrong-password")).rejects.toThrow(InvalidCredentialsError);

      expect(logins.lock).toHaveBeenCalledWith("ada@example.com", iso(LOCKOUT_SECONDS));
    });

    it("does not lock the account before that", async () => {
      const { service, logins } = build();
      logins.recordFailure.mockResolvedValue(MAX_FAILED_LOGINS - 1);

      await expect(login(service, "wrong-password")).rejects.toThrow(InvalidCredentialsError);

      expect(logins.lock).not.toHaveBeenCalled();
    });

    it("refuses a locked account even with the right password, without checking the password, and says how long to wait", async () => {
      const { service, logins, hasher } = build();
      logins.get.mockResolvedValue(loginRecord({ lockedUntil: iso(600) }));

      const error = await login(service).catch((e) => e);

      expect(error).toBeInstanceOf(AccountLockedError);
      expect(error.retryAfterSeconds).toBe(600);
      expect(hasher.verify).not.toHaveBeenCalled();
    });

    it("rounds the wait up, so a client never retries a moment too early", async () => {
      const { service, logins } = build();
      logins.get.mockResolvedValue(loginRecord({ lockedUntil: new Date(NOW.getTime() + 1500).toISOString() }));

      const error = await login(service).catch((e) => e);

      expect(error.retryAfterSeconds).toBe(2);
    });

    it("lets the account in again once the lock has passed", async () => {
      const { service, logins } = build();
      logins.get.mockResolvedValue(loginRecord({ lockedUntil: iso(-1) }));

      await expect(login(service)).resolves.toBeDefined();
    });

    it("forgets earlier failures after a successful sign-in", async () => {
      const { service, logins } = build();
      logins.get.mockResolvedValue(loginRecord({ failedAttempts: 3 }));

      await login(service);

      expect(logins.clearFailures).toHaveBeenCalledWith("ada@example.com");
    });

    it("does not write anything for an ordinary sign-in with nothing to forget", async () => {
      const { service, logins } = build();

      await login(service);

      expect(logins.clearFailures).not.toHaveBeenCalled();
    });

    it("clears an expired lock on a successful sign-in", async () => {
      const { service, logins } = build();
      logins.get.mockResolvedValue(loginRecord({ lockedUntil: iso(-1) }));

      await login(service);

      expect(logins.clearFailures).toHaveBeenCalled();
    });
  });
});

describe("AuthService.refresh", () => {
  it("swaps a valid refresh token for a new access token and a new refresh token", async () => {
    const { service, refreshTokens } = build();

    const tokens = await service.refresh(TOKEN);

    expect(refreshTokens.markUsed).toHaveBeenCalledWith("u1", "t1", NOW.toISOString());
    expect(tokens).toEqual({ accessToken: "access-for-u1", refreshToken: expect.any(String), expiresIn: 900 });
    expect(tokens.refreshToken).not.toBe(TOKEN);
  });

  it("keeps the new token in the same session as the old one", async () => {
    const { service, refreshTokens } = build();

    await service.refresh(TOKEN);

    expect(refreshTokens.create.mock.calls[0][0]).toMatchObject({ userId: "u1", familyId: "f1" });
    expect(refreshTokens.create.mock.calls[0][0].tokenId).not.toBe("t1");
  });

  it("retires the old token before issuing the new one, so it can only be used once", async () => {
    const { service, refreshTokens } = build();
    const order: string[] = [];
    refreshTokens.markUsed.mockImplementation(async () => {
      order.push("markUsed");
      return true;
    });
    refreshTokens.create.mockImplementation(async () => {
      order.push("create");
      return true;
    });

    await service.refresh(TOKEN);

    expect(order).toEqual(["markUsed", "create"]);
  });

  it.each([
    ["nothing", ""],
    ["text that is not a token", "garbage"],
    ["too few parts", "u1.t1"],
    ["too many parts", "u1.t1.s3cret.extra"],
    ["an empty part", "u1..s3cret"],
  ])("refuses %s, without looking anything up", async (_label, token) => {
    const { service, refreshTokens } = build();

    await expect(service.refresh(token)).rejects.toThrow(InvalidRefreshTokenError);

    expect(refreshTokens.get).not.toHaveBeenCalled();
  });

  it("refuses a token that does not exist", async () => {
    const { service, refreshTokens } = build();
    refreshTokens.get.mockResolvedValue(undefined);

    await expect(service.refresh(TOKEN)).rejects.toThrow(InvalidRefreshTokenError);

    expect(refreshTokens.markUsed).not.toHaveBeenCalled();
  });

  it("refuses a token with the wrong secret, and does not touch the session", async () => {
    const { service, refreshTokens } = build();

    await expect(service.refresh("u1.t1.guessed-secret")).rejects.toThrow(InvalidRefreshTokenError);

    expect(refreshTokens.markUsed).not.toHaveBeenCalled();
    expect(refreshTokens.revoke).not.toHaveBeenCalled();
  });

  it("refuses an expired token", async () => {
    const { service, refreshTokens } = build();
    refreshTokens.get.mockResolvedValue(tokenRecord({ expiresAt: iso(-1) }));

    await expect(service.refresh(TOKEN)).rejects.toThrow(InvalidRefreshTokenError);

    expect(refreshTokens.markUsed).not.toHaveBeenCalled();
  });

  it("refuses a revoked token", async () => {
    const { service, refreshTokens } = build();
    refreshTokens.get.mockResolvedValue(tokenRecord({ revokedAt: iso(-60) }));

    await expect(service.refresh(TOKEN)).rejects.toThrow(InvalidRefreshTokenError);

    expect(refreshTokens.markUsed).not.toHaveBeenCalled();
  });

  it("gives the same error whatever was wrong, so it does not tell an attacker which part they got right", async () => {
    const reasons = await Promise.all([
      build().service.refresh("garbage").catch((e: Error) => e.message),
      (async () => {
        const b = build();
        b.refreshTokens.get.mockResolvedValue(undefined);
        return b.service.refresh(TOKEN).catch((e: Error) => e.message);
      })(),
      build().service.refresh("u1.t1.wrong").catch((e: Error) => e.message),
      (async () => {
        const b = build();
        b.refreshTokens.get.mockResolvedValue(tokenRecord({ expiresAt: iso(-1) }));
        return b.service.refresh(TOKEN).catch((e: Error) => e.message);
      })(),
    ]);

    expect(new Set(reasons).size).toBe(1);
  });

  describe("a token that was already used", () => {
    it(`within ${REFRESH_REUSE_GRACE_SECONDS} seconds is refused but the session is kept, since it is most likely a client that retried`, async () => {
      const { service, refreshTokens } = build();
      refreshTokens.get.mockResolvedValue(tokenRecord({ usedAt: iso(-(REFRESH_REUSE_GRACE_SECONDS - 1)) }));
      refreshTokens.listByUser.mockResolvedValue([tokenRecord()]);

      await expect(service.refresh(TOKEN)).rejects.toThrow(InvalidRefreshTokenError);

      expect(refreshTokens.revoke).not.toHaveBeenCalled();
      expect(refreshTokens.markUsed).not.toHaveBeenCalled();
    });

    it("any longer ago means someone else has the token, so the whole session is revoked", async () => {
      const { service, refreshTokens } = build();
      refreshTokens.get.mockResolvedValue(tokenRecord({ usedAt: iso(-(REFRESH_REUSE_GRACE_SECONDS + 1)) }));
      refreshTokens.listByUser.mockResolvedValue([
        tokenRecord({ tokenId: "t1", usedAt: iso(-60) }),
        tokenRecord({ tokenId: "t2" }), // the newest token in the same session, which the thief or the owner holds
      ]);

      await expect(service.refresh(TOKEN)).rejects.toThrow(InvalidRefreshTokenError);

      expect(refreshTokens.revoke).toHaveBeenCalledWith("u1", "t1", NOW.toISOString());
      expect(refreshTokens.revoke).toHaveBeenCalledWith("u1", "t2", NOW.toISOString());
      expect(refreshTokens.create).not.toHaveBeenCalled();
    });

    it("leaves the user's other sessions alone when it revokes that one", async () => {
      const { service, refreshTokens } = build();
      refreshTokens.get.mockResolvedValue(tokenRecord({ usedAt: iso(-60) }));
      refreshTokens.listByUser.mockResolvedValue([
        tokenRecord({ tokenId: "t1", familyId: "f1" }),
        tokenRecord({ tokenId: "other", familyId: "f2" }),
      ]);

      await service.refresh(TOKEN).catch(() => undefined);

      expect(refreshTokens.revoke).toHaveBeenCalledTimes(1);
      expect(refreshTokens.revoke).toHaveBeenCalledWith("u1", "t1", NOW.toISOString());
    });

    it("does not touch tokens that are already revoked", async () => {
      const { service, refreshTokens } = build();
      refreshTokens.get.mockResolvedValue(tokenRecord({ usedAt: iso(-60) }));
      refreshTokens.listByUser.mockResolvedValue([
        tokenRecord({ tokenId: "t1" }),
        tokenRecord({ tokenId: "t0", revokedAt: iso(-3600) }),
      ]);

      await service.refresh(TOKEN).catch(() => undefined);

      expect(refreshTokens.revoke).toHaveBeenCalledTimes(1);
    });
  });

  it("refuses, without revoking anything, when two refreshes with the same token race and this one loses", async () => {
    const { service, refreshTokens } = build();
    refreshTokens.markUsed.mockResolvedValue(false);

    await expect(service.refresh(TOKEN)).rejects.toThrow(InvalidRefreshTokenError);

    expect(refreshTokens.create).not.toHaveBeenCalled();
    expect(refreshTokens.revoke).not.toHaveBeenCalled();
  });
});

describe("AuthService.logout", () => {
  it("revokes every token in the session, so no refresh token from it can be used again", async () => {
    const { service, refreshTokens } = build();
    refreshTokens.listByUser.mockResolvedValue([
      tokenRecord({ tokenId: "t1", usedAt: iso(-60) }),
      tokenRecord({ tokenId: "t2" }),
      tokenRecord({ tokenId: "x", familyId: "f2" }),
    ]);

    await service.logout(TOKEN);

    expect(refreshTokens.revoke).toHaveBeenCalledWith("u1", "t1", NOW.toISOString());
    expect(refreshTokens.revoke).toHaveBeenCalledWith("u1", "t2", NOW.toISOString());
    expect(refreshTokens.revoke).not.toHaveBeenCalledWith("u1", "x", expect.anything());
  });

  it.each([
    ["a token that is not well formed", "garbage"],
    ["a token that does not exist", "u1.t9.s3cret"],
    ["a token with the wrong secret", "u1.t1.guessed"],
  ])("does nothing, and does not complain, for %s, so logout reveals nothing about tokens", async (_label, token) => {
    const { service, refreshTokens } = build();
    refreshTokens.get.mockImplementation(async (_userId: string, tokenId: string) => (tokenId === "t1" ? tokenRecord() : undefined));

    await expect(service.logout(token)).resolves.toBeUndefined();

    expect(refreshTokens.revoke).not.toHaveBeenCalled();
  });

  it("cannot be used by someone who only knows a token id, since the secret must match", async () => {
    const { service, refreshTokens } = build();

    await service.logout("u1.t1.not-the-secret");

    expect(refreshTokens.listByUser).not.toHaveBeenCalled();
  });
});

describe("AuthService.changePassword", () => {
  const change = (service: AuthService, current = "good-password-1", next = "brand-new-password") =>
    service.changePassword("u1", { currentPassword: current, newPassword: next });

  it("replaces the password, and signs out every session", async () => {
    const { service, logins, refreshTokens } = build();
    refreshTokens.listByUser.mockResolvedValue([
      tokenRecord({ tokenId: "t1", familyId: "f1" }),
      tokenRecord({ tokenId: "t2", familyId: "f2" }),
      tokenRecord({ tokenId: "t3", familyId: "f2", revokedAt: iso(-60) }),
    ]);

    await change(service);

    expect(logins.setPasswordHash).toHaveBeenCalledWith("ada@example.com", "hash-of-brand-new-password");
    expect(refreshTokens.revoke).toHaveBeenCalledWith("u1", "t1", NOW.toISOString());
    expect(refreshTokens.revoke).toHaveBeenCalledWith("u1", "t2", NOW.toISOString());
    expect(refreshTokens.revoke).toHaveBeenCalledTimes(2);
  });

  it("keeps the device that changed it signed in, with a session that starts after the old ones were revoked", async () => {
    const { service, refreshTokens } = build();
    const order: string[] = [];
    refreshTokens.listByUser.mockResolvedValue([tokenRecord()]);
    refreshTokens.revoke.mockImplementation(async () => {
      order.push("revoke");
      return true;
    });
    refreshTokens.create.mockImplementation(async () => {
      order.push("create");
      return true;
    });

    const tokens = await change(service);

    expect(tokens).toEqual({ accessToken: "access-for-u1", refreshToken: expect.any(String), expiresIn: 900 });
    expect(order).toEqual(["revoke", "create"]);
  });

  it("refuses the wrong current password, and changes nothing", async () => {
    const { service, logins, refreshTokens } = build();

    await expect(change(service, "wrong-password")).rejects.toThrow(IncorrectPasswordError);

    expect(logins.setPasswordHash).not.toHaveBeenCalled();
    expect(refreshTokens.revoke).not.toHaveBeenCalled();
  });

  it("counts a wrong current password toward the lockout, so a stolen access token cannot be used to guess the password", async () => {
    const { service, logins } = build();
    logins.recordFailure.mockResolvedValue(MAX_FAILED_LOGINS);

    await expect(change(service, "wrong-password")).rejects.toThrow(IncorrectPasswordError);

    expect(logins.recordFailure).toHaveBeenCalledWith("ada@example.com");
    expect(logins.lock).toHaveBeenCalledWith("ada@example.com", iso(LOCKOUT_SECONDS));
  });

  it("refuses a locked account", async () => {
    const { service, logins, hasher } = build();
    logins.get.mockResolvedValue(loginRecord({ lockedUntil: iso(300) }));

    await expect(change(service)).rejects.toThrow(AccountLockedError);

    expect(hasher.verify).not.toHaveBeenCalled();
  });

  it("applies the same rules to the new password as to a new account's, and checks them before anything else", async () => {
    const { service, hasher, logins } = build();

    await expect(change(service, "good-password-1", "short")).rejects.toThrow(InvalidAuthRequestError);

    expect(hasher.verify).not.toHaveBeenCalled();
    expect(logins.setPasswordHash).not.toHaveBeenCalled();
  });

  it("forgets earlier failed attempts once the right password has been given", async () => {
    const { service, logins } = build();
    logins.get.mockResolvedValue(loginRecord({ failedAttempts: 2 }));

    await change(service);

    expect(logins.clearFailures).toHaveBeenCalledWith("ada@example.com");
  });

  it("refuses, as an unknown user, an id that has no profile", async () => {
    const { service, users } = build();
    users.get.mockResolvedValue(undefined);

    await expect(change(service)).rejects.toThrow(InvalidCredentialsError);
  });
});
