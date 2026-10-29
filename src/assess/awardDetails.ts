/**
 * Award details for Upload & details (Phase 1): award level (with AQF level)
 * and field of study, derived from the extracted degree title, the DB degree
 * level and any qualification code in the documents. Deterministic: no extra
 * LLM call, so the education read prompt and its cache are unchanged.
 */
import { prisma } from "../lib/prisma.js";
import { AQF, AWARD_LABELS, detectAwardLevel } from "./gate1.js";
import { degreeLevelToQualification } from "./extractSubjects.js";
import type { Gate1AwardLevel } from "./schemas.js";

export const AWARD_LEVEL_FIELD = "awardLevel";
export const FIELD_OF_STUDY_FIELD = "fieldOfStudy";

export const AWARD_LEVELS = Object.keys(AQF) as Gate1AwardLevel[];

export type AwardDetails = {
  awardLevel: Gate1AwardLevel;
  aqfLevel: number | null;
  awardLabel: string;
  fieldOfStudy: string | null;
};

/** A stored award level value, or null when empty / not a known level. */
export function parseAwardLevel(value: string | null | undefined): Gate1AwardLevel | null {
  const v = (value ?? "").trim();
  if (!v || v === "unknown") return null;
  return (AWARD_LEVELS as string[]).includes(v) ? (v as Gate1AwardLevel) : null;
}

export function awardLabel(level: Gate1AwardLevel): string {
  return AWARD_LABELS[level];
}

export function deriveAwardDetails(input: {
  degreeLevel: string | null;
  title: string | null;
  texts?: string[];
}): AwardDetails {
  const { award, aqfLevel } = detectAwardLevel({
    level: degreeLevelToQualification(input.degreeLevel, input.title),
    title: input.title,
    rawLevel: input.degreeLevel,
    texts: input.texts ?? [],
  });
  return {
    awardLevel: award,
    aqfLevel,
    awardLabel: AWARD_LABELS[award],
    fieldOfStudy: fieldOfStudyFromTitle(input.title),
  };
}

const AWARD_WORDS =
  /^(?:bachelor|master|masters|diploma|advanced diploma|associate degree|degree|certificate|graduate diploma|honours|honors|doctor|doctorate|science|arts|engineering technology)$/i;

/**
 * Field of study from a degree title, e.g.
 * "Bachelor of Engineering in Civil Engineering" → "Civil Engineering",
 * "Bachelor of Civil Engineering" → "Civil Engineering",
 * "B.Tech Mechanical Engineering" → "Mechanical Engineering".
 * Null when nothing beyond the award name is in the title.
 */
export function fieldOfStudyFromTitle(title: string | null | undefined): string | null {
  let t = (title ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  // Qualification codes and honours markers carry no field.
  t = t
    .replace(/\b[A-Z]{3}\d{5}\b/g, " ")
    .replace(/\((?:hons?\.?|honours|honors|with honours)\)/gi, " ")
    .replace(/\bwith (?:first class |second class )?hono(?:u)?rs\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const pick = (raw: string | undefined): string | null => {
    const v = (raw ?? "")
      .replace(/^[\s,:;–—-]+|[\s,:;.–—-]+$/g, "")
      .replace(/^(?:the|a)\s+/i, "")
      .trim();
    if (v.length < 3 || AWARD_WORDS.test(v)) return null;
    return v;
  };
  const inMatch = /\b(?:majoring in|major in|specialis(?:ation|ed) in|speciali[sz]ation in|in)\s+(.+)$/i.exec(t);
  if (inMatch) {
    const v = pick(inMatch[1]);
    if (v) return v;
  }
  const dash = /\s[–—-]\s|,\s/.exec(t);
  if (dash) {
    const v = pick(t.slice(dash.index + dash[0].length));
    if (v) return v;
  }
  const ofMatch = /\bof\s+(.+)$/i.exec(t);
  if (ofMatch) {
    const v = pick(ofMatch[1]);
    // "Bachelor of Science Computer Science" → "Computer Science".
    const broad = v ? /^(?:applied science|science|arts|engineering)\s+(.+)$/i.exec(v) : null;
    const rest = broad ? pick(broad[1]) : null;
    if (rest && !/^(?:technology|studies)$/i.test(rest)) return rest;
    if (v) return v;
  }
  const abbr =
    /^(?:B\.?\s?(?:E|Eng|Tech|Sc|S|A|Arch)|M\.?\s?(?:E|Eng|Tech|Sc|S|A)|BEng|MEng|BSc|MSc|BTech|MTech|BE|ME)\.?\s+(?:in\s+)?(.+)$/i.exec(t);
  if (abbr) return pick(abbr[1]);
  return null;
}

type EducationReadResult = {
  qualification?: { degreeTitle?: string | null } | null;
  fields?: Record<string, { value: string | null; sourceDocumentId?: string | null } & Record<string, unknown>>;
} & Record<string, unknown>;

/**
 * Add award level + field of study to an education read result (fresh or
 * cached) and save them on FieldSource for the level. A new read resets the
 * award level to "detect from title" (finalValue null), like every other
 * field a read fills in.
 */
export async function attachAwardDetails<T extends object>(
  caseId: string,
  degreeLevel: string,
  result: T,
  texts: string[],
): Promise<T> {
  const r = result as unknown as EducationReadResult;
  const title = r.qualification?.degreeTitle ?? r.fields?.degreeTitle?.value ?? null;
  if (!r.fields || !title) return result;
  const details = deriveAwardDetails({ degreeLevel, title, texts });
  const sourceDocumentId = r.fields.degreeTitle?.sourceDocumentId ?? null;
  const documentType = (r.fields.degreeTitle as { documentType?: unknown } | undefined)?.documentType ?? null;
  const rows: Array<{ field: string; extractedValue: string | null; finalValue: string | null }> = [
    { field: AWARD_LEVEL_FIELD, extractedValue: details.awardLevel, finalValue: null },
    { field: FIELD_OF_STUDY_FIELD, extractedValue: details.fieldOfStudy, finalValue: details.fieldOfStudy },
  ];
  for (const row of rows) {
    await prisma.fieldSource.upsert({
      where: {
        caseId_field_degreeLevel: { caseId, field: row.field, degreeLevel: degreeLevel as never },
      },
      create: {
        caseId,
        field: row.field,
        degreeLevel: degreeLevel as never,
        sourceDocumentId,
        extractedValue: row.extractedValue,
        finalValue: row.finalValue,
        confidence: null,
      },
      update: {
        sourceDocumentId,
        extractedValue: row.extractedValue,
        finalValue: row.finalValue,
        confidence: null,
      },
    });
  }
  const meta = (value: string | null) => ({
    value,
    confidence: null,
    sourceDocumentId,
    documentType,
    alternatives: [],
    conflict: false,
  });
  return {
    ...result,
    fields: {
      ...r.fields,
      [AWARD_LEVEL_FIELD]: meta(details.awardLevel),
      [FIELD_OF_STUDY_FIELD]: meta(details.fieldOfStudy),
    },
    award: { level: details.awardLevel, label: details.awardLabel, aqfLevel: details.aqfLevel },
  } as T;
}
