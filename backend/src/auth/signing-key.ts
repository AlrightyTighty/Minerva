import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const PEM_START = "-----BEGIN";

/**
 * Turns what was stored (a PEM, or a PEM as one line of base64, which is how it is passed to the deploy) into a
 * PEM, and checks it is an EC P-256 private key. The key is never put in an error message.
 */
export function parseSigningKey(raw: string): string {
  const value = raw.trim();
  const pem = value.startsWith(PEM_START) ? value : Buffer.from(value.replace(/\s+/g, ""), "base64").toString("utf8").trim();
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("wrong type");
    }
  } catch {
    throw new Error("The JWT signing key is not a valid EC P-256 private key in PEM form");
  }
  return pem;
}

/**
 * A key made fresh for a local run, so developing needs no setup. Tokens made with it stop working when the server
 * restarts, which is fine locally and is why it is refused anywhere else.
 */
export function generateEphemeralSigningKey(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return (privateKey.export({ type: "pkcs8", format: "pem" }) as string).trim();
}

export interface SigningKeySource {
  load(): Promise<string>;
}

/** Reads the signing key from the Secrets Manager secret the stack created for it. */
export class SecretsManagerSigningKey implements SigningKeySource {
  constructor(
    private readonly client: SecretsManagerClient,
    private readonly secretId: string,
  ) {}

  async load(): Promise<string> {
    const response = await this.client.send(new GetSecretValueCommand({ SecretId: this.secretId }));
    if (!response.SecretString) {
      throw new Error("The JWT signing key secret has no text value");
    }
    return parseSigningKey(response.SecretString);
  }
}
