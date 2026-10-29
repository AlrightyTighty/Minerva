import { generateKeyPairSync } from "node:crypto";
import { SignJWT, decodeJwt, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";
import { AccessTokenService, InvalidTokenError } from "../../src/auth/access-tokens.js";

const pem = (privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]) =>
  privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const otherKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });

const NOW = new Date("2026-10-28T12:00:00.000Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);

function service(overrides: { privateKeyPem?: string; now?: () => Date; ttlSeconds?: number } = {}) {
  return new AccessTokenService({
    privateKeyPem: pem(keys.privateKey),
    issuer: "minerva-api",
    audience: "minerva-app",
    ttlSeconds: 900,
    now: () => NOW,
    ...overrides,
  });
}

/** A token signed by someone else's key, or with other claims, the way an attacker would make one. */
async function forge(
  claims: Record<string, unknown>,
  options: { key?: ReturnType<typeof generateKeyPairSync>["privateKey"]; alg?: string; issuer?: string; audience?: string; expiresAt?: number } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: options.alg ?? "ES256" })
    .setSubject((claims.sub as string) ?? "u1")
    .setIssuer(options.issuer ?? "minerva-api")
    .setAudience(options.audience ?? "minerva-app")
    .setIssuedAt(nowSeconds)
    .setExpirationTime(options.expiresAt ?? nowSeconds + 900)
    .sign(options.key ?? keys.privateKey);
}

describe("AccessTokenService.sign", () => {
  it("makes a signed ES256 token for the user, and says how long it lasts", async () => {
    const { token, expiresIn } = await service().sign("u1");

    expect(decodeProtectedHeader(token).alg).toBe("ES256");
    expect(expiresIn).toBe(900);
    expect(decodeJwt(token)).toMatchObject({
      sub: "u1",
      iss: "minerva-api",
      aud: "minerva-app",
      iat: nowSeconds,
      exp: nowSeconds + 900,
    });
  });

  it("holds nothing about the user beyond who they are", async () => {
    const { token } = await service().sign("u1");

    expect(Object.keys(decodeJwt(token)).sort()).toEqual(["aud", "exp", "iat", "iss", "jti", "sub"]);
  });

  it("gives every token its own id", async () => {
    const [a, b] = await Promise.all([service().sign("u1"), service().sign("u1")]);

    expect(decodeJwt(a.token).jti).not.toBe(decodeJwt(b.token).jti);
  });

  it("uses the lifetime it was configured with", async () => {
    const { token, expiresIn } = await service({ ttlSeconds: 60 }).sign("u1");

    expect(expiresIn).toBe(60);
    expect(decodeJwt(token).exp).toBe(nowSeconds + 60);
  });
});

describe("AccessTokenService.verify", () => {
  it("accepts a token it made, and returns the user", async () => {
    const tokens = service();
    const { token } = await tokens.sign("u1");

    await expect(tokens.verify(token)).resolves.toEqual({ userId: "u1" });
  });

  it("accepts a token made by an earlier instance with the same key, as happens after a Lambda restarts", async () => {
    const { token } = await service().sign("u1");

    await expect(service().verify(token)).resolves.toEqual({ userId: "u1" });
  });

  it("rejects an expired token", async () => {
    const { token } = await service().sign("u1");
    const later = new Date(NOW.getTime() + 901_000);

    await expect(service({ now: () => later }).verify(token)).rejects.toThrow(InvalidTokenError);
  });

  it("accepts a token right up to the moment it expires", async () => {
    const { token } = await service().sign("u1");
    const justBefore = new Date(NOW.getTime() + 899_000);

    await expect(service({ now: () => justBefore }).verify(token)).resolves.toEqual({ userId: "u1" });
  });

  it("rejects a token signed with a different key", async () => {
    const token = await forge({}, { key: otherKeys.privateKey });

    await expect(service().verify(token)).rejects.toThrow(InvalidTokenError);
  });

  it("rejects a token whose body was changed after signing", async () => {
    const { token } = await service().sign("u1");
    const [header, , signature] = token.split(".");
    const body = Buffer.from(JSON.stringify({ ...decodeJwt(token), sub: "someone-else" })).toString("base64url");

    await expect(service().verify(`${header}.${body}.${signature}`)).rejects.toThrow(InvalidTokenError);
  });

  it("rejects a token for another audience, or from another issuer", async () => {
    await expect(service().verify(await forge({}, { audience: "someone-else" }))).rejects.toThrow(InvalidTokenError);
    await expect(service().verify(await forge({}, { issuer: "someone-else" }))).rejects.toThrow(InvalidTokenError);
  });

  it("rejects a token with no subject", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer("minerva-api")
      .setAudience("minerva-app")
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 900)
      .sign(keys.privateKey);

    await expect(service().verify(token)).rejects.toThrow(InvalidTokenError);
  });

  it("rejects a token with no expiry, which would otherwise last forever", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("u1")
      .setIssuer("minerva-api")
      .setAudience("minerva-app")
      .sign(keys.privateKey);

    await expect(service().verify(token)).rejects.toThrow(InvalidTokenError);
  });

  it("rejects an unsigned token (alg none)", async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encode({ alg: "none", typ: "JWT" })}.${encode({
      sub: "u1",
      iss: "minerva-api",
      aud: "minerva-app",
      exp: nowSeconds + 900,
    })}.`;

    await expect(service().verify(token)).rejects.toThrow(InvalidTokenError);
  });

  it("rejects a token signed with HS256 using the public key as the secret, the classic algorithm-confusion attack", async () => {
    const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }) as string;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u1")
      .setIssuer("minerva-api")
      .setAudience("minerva-app")
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 900)
      .sign(new TextEncoder().encode(publicPem));

    await expect(service().verify(token)).rejects.toThrow(InvalidTokenError);
  });

  it.each(["", "not-a-token", "a.b", "a.b.c", "Bearer abc.def.ghi"])("rejects %j without throwing anything else", async (token) => {
    await expect(service().verify(token)).rejects.toThrow(InvalidTokenError);
  });

  it("does not say why a token was refused, so an attacker learns nothing from the message", async () => {
    const expired = (await service().sign("u1")).token;
    const later = new Date(NOW.getTime() + 901_000);

    const messages = await Promise.all([
      service({ now: () => later }).verify(expired).catch((e: Error) => e.message),
      service().verify("garbage").catch((e: Error) => e.message),
      service().verify(await forge({}, { key: otherKeys.privateKey })).catch((e: Error) => e.message),
    ]);

    expect(new Set(messages).size).toBe(1);
  });
});

describe("AccessTokenService construction", () => {
  it("refuses a key that is not an EC P-256 private key, since the tokens are ES256", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });

    expect(() => service({ privateKeyPem: pem(rsa.privateKey) })).toThrow();
    expect(() => service({ privateKeyPem: "not a key" })).toThrow();
    expect(() => service({ privateKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }) as string })).toThrow();
  });
});
