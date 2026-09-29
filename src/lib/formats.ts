import type { DocumentFormat } from "@prisma/client";

const ALLOWED: Record<string, DocumentFormat> = {
  "application/pdf": "PDF",
  "image/png": "PNG",
  "image/jpeg": "JPG",
  "image/jpg": "JPG",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "DOCX",
};

const EXT: Record<string, DocumentFormat> = {
  ".pdf": "PDF",
  ".png": "PNG",
  ".jpg": "JPG",
  ".jpeg": "JPG",
  ".docx": "DOCX",
};

/** Detect format from file content (magic bytes), ignoring name/MIME. */
export function detectFormatFromBytes(bytes: Buffer): DocumentFormat | null {
  if (bytes.length < 4) return null;

  // PDF: %PDF
  if (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return "PDF";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "PNG";
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "JPG";
  }

  // DOCX is a ZIP (PK..) containing word/document.xml
  if (isZip(bytes) && containsAscii(bytes, "word/document.xml")) {
    return "DOCX";
  }

  return null;
}

function isZip(bytes: Buffer): boolean {
  // Local file header, empty archive, or spanned archive
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  );
}

function containsAscii(bytes: Buffer, needle: string): boolean {
  const n = Buffer.from(needle, "ascii");
  return bytes.includes(n);
}

/**
 * Legacy name/MIME hint. Prefer {@link detectFormatFromBytes} for validation.
 */
export function detectFormat(
  filename: string,
  mime?: string,
): DocumentFormat | null {
  if (mime) {
    const byMime = ALLOWED[mime.toLowerCase()];
    if (byMime) return byMime;
  }
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT[lower.slice(dot)] ?? null;
}

export function formatToMime(format: DocumentFormat): string {
  switch (format) {
    case "PDF":
      return "application/pdf";
    case "PNG":
      return "image/png";
    case "JPG":
      return "image/jpeg";
    case "DOCX":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
}

export function formatToExt(format: DocumentFormat): string {
  switch (format) {
    case "PDF":
      return ".pdf";
    case "PNG":
      return ".png";
    case "JPG":
      return ".jpg";
    case "DOCX":
      return ".docx";
  }
}
