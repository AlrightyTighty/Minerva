/** BDA accepts documents up to 500 MB. */
export const MAX_PDF_BYTES = 500 * 1024 * 1024;

/** The model APIs reject a single image over 3.75 MB. */
export const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;

export type FileKind = "pdf" | "image";

export interface FileTypeInfo {
  kind: FileKind;
  mimeType: string;
  /** Canonical extension used in the stored S3 key. */
  extension: string;
  maxBytes: number;
}

const PDF: FileTypeInfo = { kind: "pdf", mimeType: "application/pdf", extension: "pdf", maxBytes: MAX_PDF_BYTES };
const image = (mimeType: string, extension: string): FileTypeInfo => ({
  kind: "image",
  mimeType,
  extension,
  maxBytes: MAX_IMAGE_BYTES,
});

const BY_EXTENSION: Record<string, FileTypeInfo> = {
  pdf: PDF,
  png: image("image/png", "png"),
  jpg: image("image/jpeg", "jpg"),
  jpeg: image("image/jpeg", "jpg"),
  webp: image("image/webp", "webp"),
  gif: image("image/gif", "gif"),
};

/** The supported type for a filename, going by its extension. Undefined if it is not supported. */
export function classifyFilename(filename: string): FileTypeInfo | undefined {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) {
    return undefined;
  }
  return BY_EXTENSION[filename.slice(dot + 1).toLowerCase()];
}

/** Every upload is stored under a fixed name, so the user's filename never ends up in an S3 key. */
export function storedFilename(filename: string): string {
  const info = classifyFilename(filename);
  if (!info) {
    throw new Error(`Unsupported file type: ${filename}`);
  }
  return `original.${info.extension}`;
}
