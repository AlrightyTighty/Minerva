import { describe, expect, it } from "vitest";
import { ScryptPasswordHasher } from "../../src/auth/password.js";

const hasher = new ScryptPasswordHasher();

describe("ScryptPasswordHasher", () => {
  it("accepts the password that was hashed", async () => {
    const stored = await hasher.hash("correct horse battery staple");

    await expect(hasher.verify("correct horse battery staple", stored)).resolves.toBe(true);
  });

  it("rejects any other password, including one that differs by a single character", async () => {
    const stored = await hasher.hash("correct horse battery staple");

    await expect(hasher.verify("correct horse battery stapl", stored)).resolves.toBe(false);
    await expect(hasher.verify("Correct horse battery staple", stored)).resolves.toBe(false);
    await expect(hasher.verify("", stored)).resolves.toBe(false);
  });

  it("gives the same password a different hash each time, because each has its own random salt", async () => {
    const [a, b] = await Promise.all([hasher.hash("same password"), hasher.hash("same password")]);

    expect(a).not.toBe(b);
    await expect(hasher.verify("same password", a)).resolves.toBe(true);
    await expect(hasher.verify("same password", b)).resolves.toBe(true);
  });

  it("never contains the password", async () => {
    const stored = await hasher.hash("a-very-distinctive-password");

    expect(stored).not.toContain("a-very-distinctive-password");
  });

  it("stores the algorithm settings with the hash, so they can be raised later without breaking old passwords", async () => {
    const stored = await hasher.hash("password-123456");

    const [algorithm, cost, blockSize, parallelism] = stored.split("$");
    expect(algorithm).toBe("scrypt");
    expect(Number(cost)).toBeGreaterThanOrEqual(2 ** 14);
    expect(Number(blockSize)).toBeGreaterThanOrEqual(8);
    expect(Number(parallelism)).toBeGreaterThanOrEqual(1);
  });

  it("handles any characters, including emoji and line breaks", async () => {
    const password = "pässwörd 😀\n\t日本語 with spaces";
    const stored = await hasher.hash(password);

    await expect(hasher.verify(password, stored)).resolves.toBe(true);
  });

  it.each([
    ["an empty string", ""],
    ["text that is not a hash", "plaintext-password"],
    ["an unknown algorithm", "bcrypt$10$abc$def"],
    ["too few parts", "scrypt$16384$8"],
    ["settings that are not numbers", "scrypt$a$b$c$AAAA$AAAA"],
  ])("rejects, instead of throwing, when the stored value is %s", async (_label, stored) => {
    await expect(hasher.verify("anything", stored)).resolves.toBe(false);
  });

  it("refuses absurdly expensive settings in a stored value, so a bad record cannot be used to exhaust memory", async () => {
    await expect(hasher.verify("anything", "scrypt$1073741824$8$1$AAAA$AAAA")).resolves.toBe(false);
  });
});
