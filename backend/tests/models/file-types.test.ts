import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  classifyFilename,
  storedFilename,
} from "../../src/models/file-types.js";

describe("classifyFilename", () => {
  it.each([
    ["notes.pdf", "pdf", "application/pdf"],
    ["NOTES.PDF", "pdf", "application/pdf"],
    ["photo.png", "image", "image/png"],
    ["photo.jpg", "image", "image/jpeg"],
    ["photo.JPEG", "image", "image/jpeg"],
    ["diagram.webp", "image", "image/webp"],
    ["anim.gif", "image", "image/gif"],
    ["my.notes.v2.png", "image", "image/png"],
  ] as const)("recognises %s as a %s of type %s", (filename, kind, mimeType) => {
    expect(classifyFilename(filename)).toMatchObject({ kind, mimeType });
  });

  it.each(["notes.docx", "notes.md", "archive.zip", "photo.heic", "photo.svg", "noextension", "pdf", ".pdf.exe"])(
    "does not recognise %s",
    (filename) => {
      expect(classifyFilename(filename)).toBeUndefined();
    },
  );

  it("limits PDFs to BDA's 500 MB and images to the 3.75 MB the model APIs accept", () => {
    expect(MAX_PDF_BYTES).toBe(500 * 1024 * 1024);
    expect(MAX_IMAGE_BYTES).toBe(3.75 * 1024 * 1024);
    expect(classifyFilename("a.pdf")?.maxBytes).toBe(MAX_PDF_BYTES);
    expect(classifyFilename("a.png")?.maxBytes).toBe(MAX_IMAGE_BYTES);
  });
});

describe("storedFilename", () => {
  // the original name never goes into an S3 key, only a fixed name with a canonical extension
  it.each([
    ["notes.pdf", "original.pdf"],
    ["NOTES.PDF", "original.pdf"],
    ["photo.png", "original.png"],
    ["photo.jpeg", "original.jpg"],
    ["photo.JPG", "original.jpg"],
    ["diagram.webp", "original.webp"],
    ["anim.gif", "original.gif"],
  ])("stores %s as %s", (filename, stored) => {
    expect(storedFilename(filename)).toBe(stored);
  });
});
