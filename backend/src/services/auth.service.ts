import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AccessTokenSigner } from "../auth/access-tokens.js";
import type { PasswordHasher } from "../auth/password.js";
import type { LoginRecord, RefreshTokenRecord, UserProfile } from "../models/items.js";
import type { LoginsRepository } from "../repositories/logins.repository.js";
import type { RefreshTokensRepository } from "../repositories/refresh-tokens.repository.js";
import type { UsersRepository } from "../repositories/users.repository.js";

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_SECONDS = 15 * 60;
export const REFRESH_TOKEN_DAYS = 30;
/** A retired refresh token used again within this long is a client that retried, not a thief. */
export const REFRESH_REUSE_GRACE_SECONDS = 10;
export const PASSWORD_MIN_CHARS = 10;
export const PASSWORD_MAX_CHARS = 128;

const MAX_EMAIL_CHARS = 254;
const MAX_NAME_CHARS = 100;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** How long after a refresh token expires the database keeps it, before its TTL clears it. */
const TTL_GRACE_SECONDS = 7 * 24 * 3600;

export class InvalidAuthRequestError extends Error {}

export class EmailTakenError extends Error {
  constructor() {
    super("An account with this email already exists");
  }
}

/** The email or password was wrong. Never says which, and an unknown email looks exactly like a wrong password. */
export class InvalidCredentialsError extends Error {
  constructor() {
    super("Incorrect email or password");
  }
}

export class IncorrectPasswordError extends Error {
  constructor() {
    super("Current password is incorrect");
  }
}

export class AccountLockedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Too many failed attempts. Try again later.");
  }
}

/** The refresh token cannot be used, for any reason. Never says which. */
export class InvalidRefreshTokenError extends Error {
  constructor() {
    super("Invalid or expired refresh token");
  }
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  /** How many seconds the access token lasts. */
  expiresIn: number;
}

export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

export interface AuthServiceDeps {
  users: Pick<UsersRepository, "createWithLogin" | "get">;
  logins: Pick<LoginsRepository, "get" | "recordFailure" | "lock" | "clearFailures" | "setPasswordHash">;
  refreshTokens: Pick<RefreshTokensRepository, "create" | "get" | "markUsed" | "revoke" | "listByUser">;
  hasher: PasswordHasher;
  tokens: AccessTokenSigner;
  newId: () => string;
  /** The secret half of a refresh token. */
  randomSecret?: () => string;
  now: () => Date;
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const length = (text: string) => Array.from(text).length;

function checkPassword(password: string): void {
  const chars = length(password);
  if (chars < PASSWORD_MIN_CHARS || chars > PASSWORD_MAX_CHARS) {
    throw new InvalidAuthRequestError(
      `Password must be between ${PASSWORD_MIN_CHARS} and ${PASSWORD_MAX_CHARS} characters`,
    );
  }
}

function checkName(name: string, field: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || length(trimmed) > MAX_NAME_CHARS) {
    throw new InvalidAuthRequestError(`${field} must be between 1 and ${MAX_NAME_CHARS} characters`);
  }
  return trimmed;
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/** A refresh token is `<userId>.<tokenId>.<secret>`. */
function parseRefreshToken(token: string): { userId: string; tokenId: string; secret: string } | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part === "")) {
    return undefined;
  }
  return { userId: parts[0], tokenId: parts[1], secret: parts[2] };
}

export class AuthService {
  private readonly randomSecret: () => string;
  private dummyHash?: Promise<string>;

  constructor(private readonly deps: AuthServiceDeps) {
    this.randomSecret = deps.randomSecret ?? (() => randomBytes(32).toString("base64url"));
  }

  async register(input: RegisterInput): Promise<{ user: UserProfile; tokens: SessionTokens }> {
    const { users, hasher, newId, now } = this.deps;

    const email = normalizeEmail(input.email);
    if (email.length > MAX_EMAIL_CHARS || !EMAIL_PATTERN.test(email)) {
      throw new InvalidAuthRequestError("Enter a valid email address");
    }
    checkPassword(input.password);
    const firstName = checkName(input.firstName, "First name");
    const lastName = checkName(input.lastName, "Last name");

    const createdAt = now().toISOString();
    const user: UserProfile = { userId: newId(), email, firstName, lastName, studyPreferences: null, createdAt };
    const login: LoginRecord = {
      email,
      userId: user.userId,
      passwordHash: await hasher.hash(input.password),
      failedAttempts: 0,
      createdAt,
    };
    if (!(await users.createWithLogin(user, login))) {
      throw new EmailTakenError();
    }
    return { user, tokens: await this.startSession(user.userId) };
  }

  async login(input: { email: string; password: string }): Promise<{ user: UserProfile; tokens: SessionTokens }> {
    const { logins, users, hasher } = this.deps;
    const email = normalizeEmail(input.email);

    const login = await logins.get(email);
    if (!login) {
      // the same work as for a real account, so the response time does not say whether the email has one
      await hasher.verify(input.password, await this.fakeHash());
      throw new InvalidCredentialsError();
    }
    await this.checkNotLocked(login);

    if (!(await hasher.verify(input.password, login.passwordHash))) {
      await this.recordFailure(email);
      throw new InvalidCredentialsError();
    }
    await this.forgetFailures(login);

    const user = await users.get(login.userId);
    if (!user) {
      throw new InvalidCredentialsError();
    }
    return { user, tokens: await this.startSession(user.userId) };
  }

  /** Swaps a refresh token for a new pair. Each refresh token works once. */
  async refresh(refreshToken: string): Promise<SessionTokens> {
    const { refreshTokens, now } = this.deps;

    const record = await this.findToken(refreshToken);
    if (!record || record.revokedAt || Date.parse(record.expiresAt) <= now().getTime()) {
      throw new InvalidRefreshTokenError();
    }

    if (record.usedAt) {
      // used and then presented again. A client that retried is fine, but later than that someone else holds a
      // copy, so the whole session is ended and both holders have to sign in again
      const sinceUse = now().getTime() - Date.parse(record.usedAt);
      if (sinceUse > REFRESH_REUSE_GRACE_SECONDS * 1000) {
        await this.revokeFamily(record);
      }
      throw new InvalidRefreshTokenError();
    }

    // retired before the new one is issued, and only one of two simultaneous refreshes gets past this
    if (!(await refreshTokens.markUsed(record.userId, record.tokenId, now().toISOString()))) {
      throw new InvalidRefreshTokenError();
    }
    return this.issue(record.userId, record.familyId);
  }

  /** Ends the session the refresh token belongs to. Anything that is not a valid token is ignored. */
  async logout(refreshToken: string): Promise<void> {
    const record = await this.findToken(refreshToken);
    if (record) {
      await this.revokeFamily(record);
    }
  }

  /** Changes the password and signs out every session, then starts a new one so this device stays signed in. */
  async changePassword(userId: string, input: { currentPassword: string; newPassword: string }): Promise<SessionTokens> {
    const { users, logins, hasher } = this.deps;

    checkPassword(input.newPassword);

    const user = await users.get(userId);
    const login = user ? await logins.get(user.email) : undefined;
    if (!user || !login) {
      throw new InvalidCredentialsError();
    }
    await this.checkNotLocked(login);

    if (!(await hasher.verify(input.currentPassword, login.passwordHash))) {
      // counted like a failed sign-in, so a stolen access token cannot be used to guess the password
      await this.recordFailure(user.email);
      throw new IncorrectPasswordError();
    }
    await this.forgetFailures(login);

    await logins.setPasswordHash(user.email, await hasher.hash(input.newPassword));
    await this.revokeAll(userId);
    return this.startSession(userId);
  }

  private startSession(userId: string): Promise<SessionTokens> {
    return this.issue(userId, this.deps.newId());
  }

  /** A new access token and refresh token, in the session `familyId`. */
  private async issue(userId: string, familyId: string): Promise<SessionTokens> {
    const { refreshTokens, tokens, newId, now } = this.deps;

    const secret = this.randomSecret();
    const tokenId = newId();
    const issuedAt = now();
    const expiresAt = issuedAt.getTime() + REFRESH_TOKEN_DAYS * 86400_000;
    const record: RefreshTokenRecord = {
      tokenId,
      userId,
      familyId,
      secretHash: sha256(secret),
      expiresAt: new Date(expiresAt).toISOString(),
      createdAt: issuedAt.toISOString(),
      ttl: Math.floor(expiresAt / 1000) + TTL_GRACE_SECONDS,
    };
    if (!(await refreshTokens.create(record))) {
      throw new Error(`Refresh token id collision for ${tokenId}`);
    }
    const access = await tokens.sign(userId);
    return { accessToken: access.token, refreshToken: `${userId}.${tokenId}.${secret}`, expiresIn: access.expiresIn };
  }

  /** The stored token a presented one refers to, if the presented secret is the right one. */
  private async findToken(refreshToken: string): Promise<RefreshTokenRecord | undefined> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) {
      return undefined;
    }
    const record = await this.deps.refreshTokens.get(parsed.userId, parsed.tokenId);
    return record && sameHash(sha256(parsed.secret), record.secretHash) ? record : undefined;
  }

  private async revokeFamily(record: RefreshTokenRecord): Promise<void> {
    const tokens = await this.deps.refreshTokens.listByUser(record.userId);
    await this.revoke(tokens.filter((token) => token.familyId === record.familyId));
  }

  private async revokeAll(userId: string): Promise<void> {
    await this.revoke(await this.deps.refreshTokens.listByUser(userId));
  }

  private async revoke(tokens: RefreshTokenRecord[]): Promise<void> {
    const revokedAt = this.deps.now().toISOString();
    for (const token of tokens) {
      if (!token.revokedAt) {
        await this.deps.refreshTokens.revoke(token.userId, token.tokenId, revokedAt);
      }
    }
  }

  private async checkNotLocked(login: LoginRecord): Promise<void> {
    if (!login.lockedUntil) return;
    const remaining = Date.parse(login.lockedUntil) - this.deps.now().getTime();
    if (remaining > 0) {
      throw new AccountLockedError(Math.ceil(remaining / 1000));
    }
  }

  private async recordFailure(email: string): Promise<void> {
    const failures = await this.deps.logins.recordFailure(email);
    if (failures >= MAX_FAILED_LOGINS) {
      const until = new Date(this.deps.now().getTime() + LOCKOUT_SECONDS * 1000).toISOString();
      await this.deps.logins.lock(email, until);
    }
  }

  private async forgetFailures(login: LoginRecord): Promise<void> {
    if (login.failedAttempts > 0 || login.lockedUntil) {
      await this.deps.logins.clearFailures(login.email);
    }
  }

  /** A real hash of nothing in particular, made once, for the work an unknown email has to do. */
  private fakeHash(): Promise<string> {
    this.dummyHash ??= this.deps.hasher.hash("a password that nobody has");
    return this.dummyHash;
  }
}
