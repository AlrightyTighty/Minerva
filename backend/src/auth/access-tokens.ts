import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

/** The token is not one this API issued, or it has expired. Deliberately says nothing about which. */
export class InvalidTokenError extends Error {
  constructor() {
    super("Invalid access token");
  }
}

export interface AccessTokenSigner {
  sign(userId: string): Promise<{ token: string; expiresIn: number }>;
}

export interface AccessTokenVerifier {
  verify(token: string): Promise<{ userId: string }>;
}

export interface AccessTokenConfig {
  /** An EC P-256 private key in PKCS#8 PEM form. The public key is worked out from it. */
  privateKeyPem: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
  now?: () => Date;
}

const ALGORITHM = "ES256";

/**
 * Short-lived ES256 access tokens. Checking one needs only the key and the clock, with no database read.
 * The only algorithm accepted is ES256, which rules out `none` and the attack that signs with the public key.
 */
export class AccessTokenService implements AccessTokenSigner, AccessTokenVerifier {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly now: () => Date;

  constructor(private readonly config: AccessTokenConfig) {
    const privateKey = createPrivateKey(config.privateKeyPem);
    if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("The signing key must be an EC P-256 private key");
    }
    this.privateKey = privateKey;
    this.publicKey = createPublicKey(privateKey);
    this.now = config.now ?? (() => new Date());
  }

  async sign(userId: string): Promise<{ token: string; expiresIn: number }> {
    const issuedAt = Math.floor(this.now().getTime() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
      .setSubject(userId)
      .setIssuer(this.config.issuer)
      .setAudience(this.config.audience)
      .setJti(randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.config.ttlSeconds)
      .sign(this.privateKey);
    return { token, expiresIn: this.config.ttlSeconds };
  }

  async verify(token: string): Promise<{ userId: string }> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        algorithms: [ALGORITHM],
        issuer: this.config.issuer,
        audience: this.config.audience,
        currentDate: this.now(),
        requiredClaims: ["sub", "exp"],
      });
      if (typeof payload.sub !== "string" || payload.sub === "") {
        throw new InvalidTokenError();
      }
      return { userId: payload.sub };
    } catch {
      throw new InvalidTokenError();
    }
  }
}
