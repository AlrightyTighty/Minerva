import { describe, expect, it } from "vitest";
import {
  assertKeyId,
  courseFilesPrefix,
  fileSk,
  kbPartKey,
  parseRawKey,
  parseS3Key,
  processedKey,
  rawKey,
  sidecarKey,
  threadSk,
  userPk,
  WORKPLAN_PREFIX,
  workPlanSk,
  REFRESH_PREFIX,
  loginPk,
  loginSk,
  refreshSk,
} from "../../src/models/keys.js";

const ref = { userId: "u1", courseId: "c1", fileId: "f1" };

describe("dynamo keys", () => {
  it("builds type-first sort keys", () => {
    expect(userPk("u1")).toBe("USER#u1");
    expect(fileSk("c1", "f1")).toBe("FILE#c1#f1");
    expect(threadSk("c1", "t1")).toBe("THREAD#c1#t1");
  });

  it("keys a login by email, which is how a person signs in, and a refresh token under its user", () => {
    expect(loginPk("ada@example.com")).toBe("EMAIL#ada@example.com");
    expect(loginSk()).toBe("LOGIN");
    expect(refreshSk("t1")).toBe("REFRESH#t1");
    expect(refreshSk("t1").startsWith(REFRESH_PREFIX)).toBe(true);
    expect(() => refreshSk("t#1")).toThrow();
  });

  it("never lets two different emails share a key, whatever case they are written in", () => {
    // the service lowercases emails first, and the key refuses anything that has not been
    expect(() => loginPk("Ada@Example.com")).toThrow();
    expect(() => loginPk("")).toThrow();
  });

  it("keys a work plan under the user, with no course since a plan spans courses", () => {
    expect(workPlanSk("w1")).toBe("WORKPLAN#w1");
    expect(workPlanSk("w1").startsWith(WORKPLAN_PREFIX)).toBe(true);
    expect(() => workPlanSk("w#1")).toThrow();
  });

  it("a course prefix only matches that course's items", () => {
    const prefix = courseFilesPrefix("c1");
    expect(fileSk("c1", "f1").startsWith(prefix)).toBe(true);
    expect(fileSk("c10", "f1").startsWith(prefix)).toBe(false);
  });

  it("rejects ids that would break key parsing", () => {
    expect(() => assertKeyId("a#b")).toThrow();
    expect(() => assertKeyId("a/b")).toThrow();
    expect(() => assertKeyId("")).toThrow();
  });
});

describe("s3 keys", () => {
  it("encodes the ids in every pipeline path", () => {
    expect(rawKey(ref, "original.pdf")).toBe("raw/u1/c1/f1/original.pdf");
    expect(processedKey(ref)).toBe("processed/u1/c1/f1/full.md");
    expect(kbPartKey(ref, 1)).toBe("kb-source/u1/c1/f1/part-01.md");
  });

  it("names the sidecar after its source file", () => {
    expect(sidecarKey(kbPartKey(ref, 1))).toBe("kb-source/u1/c1/f1/part-01.md.metadata.json");
  });

  it("parses the ids back out of a raw key", () => {
    expect(parseRawKey("raw/u1/c1/f1/original.pdf")).toEqual({ ref, filename: "original.pdf" });
  });

  it("only treats raw/ keys as raw", () => {
    expect(parseRawKey("processed/u1/c1/f1/full.md")).toBeUndefined();
    expect(parseRawKey("raw/u1/c1")).toBeUndefined();
  });

  it("parses any pipeline prefix", () => {
    expect(parseS3Key("bda-output/u1/c1/f1/abc/job_metadata.json")?.ref).toEqual(ref);
    expect(parseS3Key("somewhere/u1/c1/f1/x")).toBeUndefined();
  });
});
