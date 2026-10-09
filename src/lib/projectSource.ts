import type { ProjectSource } from "@prisma/client";

export const PROJECT_SOURCE_VALUES = [
  "WORK_BASED",
  "ACADEMIC_PERSONAL",
  "FIRM_PREPARED",
] as const satisfies readonly ProjectSource[];

/**
 * "Work-based project" / "academic/personal" / "FIRM_PREPARED" → enum value;
 * "" → null (not chosen yet); anything else → undefined (invalid).
 */
export function parseProjectSource(raw: string): ProjectSource | null | undefined {
  const normalized = raw
    .trim()
    .toUpperCase()
    .replace(/[\s/-]+/g, "_")
    .replace(/_PROJECT$/, "");
  if (!normalized) return null;
  return (PROJECT_SOURCE_VALUES as readonly string[]).includes(normalized)
    ? (normalized as ProjectSource)
    : undefined;
}
