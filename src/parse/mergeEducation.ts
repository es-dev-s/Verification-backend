import { computeDuration } from "./duration.js";
import { isLikelyAcronymMatch } from "./institutionMatch.js";
import type {
  DocumentTypeLabel,
  EducationExtract,
  PerSourceEducation,
} from "./schemas.js";

export type FieldName =
  | "degreeTitle"
  | "institution"
  | "country"
  | "durationYears";

export type Alternative = {
  value: string;
  sourceDocumentId: string;
  documentType: DocumentTypeLabel;
  /** When set, explains a non-conflict alternative (e.g. abbreviation). */
  label?: string;
};

export type MergedField = {
  value: string | null;
  sourceDocumentId: string | null;
  documentType: DocumentTypeLabel | null;
  confidence: number | null;
  alternatives: Alternative[];
  conflict: boolean;
  calculated?: boolean;
};

export type MergeResult = {
  fields: Record<FieldName, MergedField>;
  durationCalculated: boolean;
  fromCvOnly: boolean;
  flags: string[];
};

const PRIORITY: Record<FieldName, DocumentTypeLabel[]> = {
  degreeTitle: ["CERTIFICATE", "TRANSCRIPT", "CV"],
  institution: ["CERTIFICATE", "TRANSCRIPT", "CV"],
  country: ["CERTIFICATE", "TRANSCRIPT", "CV"],
  durationYears: ["TRANSCRIPT", "CERTIFICATE", "CV"],
};

export function normalizeValue(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/\buniv\.?\b/g, "university")
    .replace(/\binst\.?\b/g, "institute")
    .replace(/\bdept\.?\b/g, "department")
    .replace(/\bb\.?\s*sc\.?\b/g, "bsc")
    .replace(/\bb\.?\s*a\.?\b/g, "ba")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function priorityRank(
  type: DocumentTypeLabel,
  field: FieldName,
): number {
  const order = PRIORITY[field];
  const idx = order.indexOf(type);
  return idx === -1 ? 99 : idx;
}

function valuesEquivalent(
  field: FieldName,
  a: string,
  b: string,
): { match: boolean; abbreviation?: boolean } {
  if (normalizeValue(a) === normalizeValue(b)) {
    return { match: true };
  }
  if (field === "institution" && isLikelyAcronymMatch(a, b)) {
    return { match: true, abbreviation: true };
  }
  return { match: false };
}

function pickField(
  sources: Array<{
    documentId: string;
    documentType: DocumentTypeLabel;
    value: string | null;
    confidence: number | null;
  }>,
  field: FieldName,
): MergedField {
  const nonempty = sources.filter((s) => s.value != null && s.value.trim() !== "");
  if (!nonempty.length) {
    return {
      value: null,
      sourceDocumentId: null,
      documentType: null,
      confidence: null,
      alternatives: [],
      conflict: false,
    };
  }

  nonempty.sort(
    (a, b) =>
      priorityRank(a.documentType, field) -
      priorityRank(b.documentType, field),
  );

  // For institutions, prefer the longer full name among equal-priority ties
  // after primary sort (stable enough: re-sort same priority by length desc).
  if (field === "institution") {
    nonempty.sort((a, b) => {
      const pr =
        priorityRank(a.documentType, field) -
        priorityRank(b.documentType, field);
      if (pr !== 0) return pr;
      return (b.value?.length ?? 0) - (a.value?.length ?? 0);
    });
  }

  const winner = nonempty[0]!;
  const alternatives: Alternative[] = [];
  let conflict = false;

  for (const other of nonempty.slice(1)) {
    const eq = valuesEquivalent(field, winner.value!, other.value!);
    if (eq.match) {
      if (eq.abbreviation) {
        alternatives.push({
          value: other.value!,
          sourceDocumentId: other.documentId,
          documentType: other.documentType,
          label: "same institution, abbreviated",
        });
      }
      continue;
    }
    conflict = true;
    alternatives.push({
      value: other.value!,
      sourceDocumentId: other.documentId,
      documentType: other.documentType,
    });
  }

  return {
    value: winner.value,
    sourceDocumentId: winner.documentId,
    documentType: winner.documentType,
    confidence: winner.confidence,
    alternatives,
    conflict,
  };
}

export function mergeEducation(sources: PerSourceEducation[]): MergeResult {
  const flags: string[] = [];
  const types = new Set(sources.map((s) => s.documentType));
  const fromCvOnly = types.size === 1 && types.has("CV");

  for (const s of sources) {
    if (s.extract.multipleBachelors) {
      flags.push(`multiple_bachelors:${s.documentId}`);
    }
  }

  const degreeTitle = pickField(
    sources.map((s) => ({
      documentId: s.documentId,
      documentType: s.documentType,
      value: s.extract.degreeTitle,
      confidence: s.extract.confidence?.degreeTitle ?? null,
    })),
    "degreeTitle",
  );

  const institution = pickField(
    sources.map((s) => ({
      documentId: s.documentId,
      documentType: s.documentType,
      value: s.extract.institution,
      confidence: s.extract.confidence?.institution ?? null,
    })),
    "institution",
  );

  const country = pickField(
    sources.map((s) => ({
      documentId: s.documentId,
      documentType: s.documentType,
      value: s.extract.country,
      confidence: s.extract.confidence?.country ?? null,
    })),
    "country",
  );

  // Duration: compute per source, then pick by duration priority
  const durationCandidates = sources.map((s) => {
    const d = computeDuration({
      statedDuration: s.extract.statedDuration,
      start: s.extract.start,
      end: s.extract.end,
    });
    return {
      documentId: s.documentId,
      documentType: s.documentType,
      value: d.years != null ? String(d.years) : null,
      confidence: s.extract.confidence?.statedDuration ?? null,
      calculated: d.calculated,
      years: d.years,
    };
  });

  const durationField = pickField(
    durationCandidates.map((c) => ({
      documentId: c.documentId,
      documentType: c.documentType,
      value: c.value,
      confidence: c.confidence,
    })),
    "durationYears",
  );

  const winnerDuration = durationCandidates.find(
    (c) =>
      c.documentId === durationField.sourceDocumentId &&
      c.value === durationField.value,
  );

  const durationYears: MergedField = {
    ...durationField,
    value: winnerDuration?.years != null ? String(winnerDuration.years) : durationField.value,
    calculated: winnerDuration?.calculated ?? false,
  };

  for (const [name, f] of Object.entries({
    degreeTitle,
    institution,
    country,
    durationYears,
  }) as Array<[FieldName, MergedField]>) {
    if (f.conflict) flags.push(`conflict:${name}`);
  }

  return {
    fields: { degreeTitle, institution, country, durationYears },
    durationCalculated: Boolean(durationYears.calculated),
    fromCvOnly,
    flags,
  };
}

export function emptyEducationExtract(): EducationExtract {
  return {
    degreeTitle: null,
    institution: null,
    country: null,
    start: null,
    end: null,
    statedDuration: null,
    multipleBachelors: false,
    confidence: {},
  };
}
