import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, stored: string): Promise<boolean>;
}

// Settings for new hashes. They are stored with each hash, so raising them later leaves old passwords working.
const COST = 2 ** 15;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// A stored value is only trusted this far, so a bad record cannot be used to make the server spend all its memory.
const MAX_COST = 2 ** 17;
const MAX_BLOCK_SIZE = 16;
const MAX_PARALLELISM = 4;

function derive(password: string, salt: Buffer, cost: number, blockSize: number, parallelism: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // 128 * cost * blockSize bytes are needed, and node's default limit is lower than the cost used here
    scrypt(
      password.normalize("NFKC"),
      salt,
      KEY_LENGTH,
      { N: cost, r: blockSize, p: parallelism, maxmem: 256 * cost * blockSize },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** scrypt, from Node's own crypto, so there is no native code to bundle for Lambda. */
export class ScryptPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const key = await derive(password, salt, COST, BLOCK_SIZE, PARALLELISM);
    return ["scrypt", COST, BLOCK_SIZE, PARALLELISM, salt.toString("base64"), key.toString("base64")].join("$");
  }

  /** False, never an error, for anything that is not a hash this class made. */
  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") {
      return false;
    }
    const [cost, blockSize, parallelism] = parts.slice(1, 4).map(Number);
    if (
      ![cost, blockSize, parallelism].every((n) => Number.isInteger(n) && n > 0) ||
      cost > MAX_COST ||
      blockSize > MAX_BLOCK_SIZE ||
      parallelism > MAX_PARALLELISM ||
      (cost & (cost - 1)) !== 0
    ) {
      return false;
    }
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    if (salt.length === 0 || expected.length === 0) {
      return false;
    }
    try {
      const actual = await derive(password, salt, cost, blockSize, parallelism);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
}
