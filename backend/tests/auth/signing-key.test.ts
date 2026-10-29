import { generateKeyPairSync } from "node:crypto";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it, vi } from "vitest";
import { SecretsManagerSigningKey, parseSigningKey } from "../../src/auth/signing-key.js";

const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PEM = (ec.privateKey.export({ type: "pkcs8", format: "pem" }) as string).trim();
const rsaPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

// The key is passed to the deploy as one line of base64, since a PEM has line breaks that are awkward on a command line.
const base64 = (text: string) => Buffer.from(text).toString("base64");

describe("parseSigningKey", () => {
  it("accepts a PEM", () => {
    expect(parseSigningKey(PEM)).toBe(PEM);
  });

  it("accepts the PEM as one line of base64, which is how it is passed to the deploy", () => {
    expect(parseSigningKey(base64(PEM))).toBe(PEM);
  });

  it("ignores spaces and line breaks around the value", () => {
    expect(parseSigningKey(`\n  ${PEM}\n\n`)).toBe(PEM);
    expect(parseSigningKey(`  ${base64(PEM)}\n`)).toBe(PEM);
  });

  it("accepts base64 that has been wrapped over several lines", () => {
    const wrapped = base64(PEM).replace(/(.{64})/g, "$1\n");

    expect(parseSigningKey(wrapped)).toBe(PEM);
  });

  it.each([
    ["nothing", ""],
    ["only spaces", "   "],
    ["text that is not a key", "hello"],
    ["base64 of text that is not a key", base64("hello")],
    ["an RSA key, since the tokens are ES256", rsaPem],
    ["a public key", ec.publicKey.export({ type: "spki", format: "pem" }) as string],
  ])("refuses %s", (_label, value) => {
    expect(() => parseSigningKey(value)).toThrow();
  });

  it("never puts the key in the error", () => {
    const attempt = () => parseSigningKey(`${PEM.slice(0, 80)}CORRUPTED`);

    expect(attempt).toThrow();
    try {
      attempt();
    } catch (error) {
      expect((error as Error).message).not.toContain(PEM.slice(40, 80));
    }
  });
});

describe("SecretsManagerSigningKey", () => {
  const build = (response: unknown) => {
    const send = vi.fn().mockResolvedValue(response);
    return { source: new SecretsManagerSigningKey({ send } as unknown as SecretsManagerClient, "arn:aws:secretsmanager:us-east-2:1:secret:jwt"), send };
  };

  it("reads the secret by its ARN and returns the key", async () => {
    const { source, send } = build({ SecretString: base64(PEM) });

    await expect(source.load()).resolves.toBe(PEM);
    expect(send.mock.calls[0][0].input).toEqual({ SecretId: "arn:aws:secretsmanager:us-east-2:1:secret:jwt" });
  });

  it("fails when the secret has no text value", async () => {
    const { source } = build({ SecretBinary: new Uint8Array([1]) });

    await expect(source.load()).rejects.toThrow();
  });

  it("fails when the secret is not a usable key, without ever putting the secret in the error", async () => {
    const { source } = build({ SecretString: "super-secret-but-not-a-key" });

    await expect(source.load()).rejects.toThrow();
    await expect(source.load()).rejects.not.toThrow(/super-secret/);
  });

  it("lets a failure to reach Secrets Manager through, so the API does not start without a key", async () => {
    const send = vi.fn().mockRejectedValue(new Error("AccessDenied"));
    const source = new SecretsManagerSigningKey({ send } as unknown as SecretsManagerClient, "arn");

    await expect(source.load()).rejects.toThrow("AccessDenied");
  });
});
