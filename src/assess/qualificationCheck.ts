import type { Rubric } from "./loadRubric.js";
import { hasTopicWord } from "./matchSubjects.js";
import type { QualificationCheckResult } from "./score.js";
import type { Gate1AwardLevel, QualificationType } from "./schemas.js";

/** One qualification on the case (level mapped for scoring, title as entered/extracted). */
export type QualificationInfo = {
  level: QualificationType;
  title: string | null;
  /** DB degree level as stored (e.g. "phd"), for Step 1 routing. */
  rawLevel?: string | null;
  /** Transcript texts at this qualification's level (routing spots UEE62122 etc.). */
  texts?: string[];
  /** Stated programme length in years (Qualification.durationYears; Gate 1 check). */
  durationYears?: number | null;
  /** Country / institution (Gate 1 "may be recognised higher" config hook). */
  country?: string | null;
  institution?: string | null;
  /** Field of study (Upload & details); added to the title for the engineering signal. */
  fieldOfStudy?: string | null;
  /** Award level chosen by the assessor (null = detect from the title). */
  awardOverride?: Gate1AwardLevel | null;
  /** Counted duration entered by the assessor (Transcript data / Verify details). */
  countedYearsOverride?: number | null;
  /** Engineering subject share (0–1) entered by the assessor. */
  engineeringShareOverride?: number | null;
};

/**
 * Step 1 qualification check for one occupation and one transcript pool.
 *
 * Qualification level and duration are decided by Gate 1 (gate1.ts) before
 * any scoring, so there is no level cap here any more.
 * - levelPolicy "diploma_ok" + titleCheck (312511 Mechanical Engineering
 *   Draftsperson): diploma levels are fine, but the qualification title must
 *   read as the right field; a failing or missing title is capped at
 *   conditional with a note so an assessor confirms it.
 */
export function checkQualification(
  rubric: Rubric,
  poolLevels: readonly QualificationType[],
  qualifications: readonly QualificationInfo[] = [],
): QualificationCheckResult {
  const notes: string[] = [];
  let capAtConditional = false;

  const knownPool = poolLevels.filter((l) => l !== "unknown");

  const titleCheck = rubric.qualificationCheck?.titleCheck;
  if (titleCheck?.allOf.length) {
    // Titles of the qualifications this pool came from (all titles when the
    // pool level is unknown or no qualification sits at that level).
    const atLevel = qualifications.filter(
      (q) => q.title?.trim() && (knownPool as readonly QualificationType[]).includes(q.level),
    );
    const titles = (atLevel.length
      ? atLevel
      : qualifications.filter((q) => q.title?.trim())
    ).map((q) => q.title!.trim());
    const ok = titles.filter((t) =>
      titleCheck.allOf.every((group) => hasTopicWord(t, group)),
    );
    if (!titles.length) {
      capAtConditional = true;
      notes.push(
        `Qualification title not on file: confirm it is primarily ${fieldLabel(rubric)} before verifying (Step 1).`,
      );
    } else if (!ok.length) {
      capAtConditional = true;
      notes.push(
        `Qualification "${titles.join('", "')}" does not read as ${fieldLabel(rubric)}: assessor to confirm equivalence (Step 1).`,
      );
    }
  }
  return { capAtConditional, notes };
}

function fieldLabel(rubric: Rubric): string {
  if (rubric.anzscoCode === "312511") {
    return "Mechanical Engineering Drafting/Design (a mechanical qualification whose title names drafting, design or CAD)";
  }
  return `a ${rubric.title} qualification`;
}
