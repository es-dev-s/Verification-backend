import type { Rubric } from "./loadRubric.js";
import { hasTopicWord } from "./matchSubjects.js";
import type { QualificationCheckResult } from "./score.js";
import { isDiplomaLevel, type QualificationType } from "./schemas.js";

/** One qualification on the case (level mapped for scoring, title as entered/extracted). */
export type QualificationInfo = {
  level: QualificationType;
  title: string | null;
  /** DB degree level as stored (e.g. "phd"), for Step 1 routing. */
  rawLevel?: string | null;
  /** Transcript texts at this qualification's level (routing spots UEE62122 etc.). */
  texts?: string[];
};

export const DIPLOMA_ONLY_NOTE =
  "diploma-level qualification; professional engineer occupations expect a bachelor's";

/**
 * Step 1 qualification check for one occupation and one transcript pool.
 *
 * - Default (professional engineer flows, levelPolicy "bachelor_expected"):
 *   when the pool is diploma / advanced diploma / associate degree only, the
 *   result is capped at conditional with DIPLOMA_ONLY_NOTE.
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
  const policy = rubric.qualificationCheck?.levelPolicy ?? "bachelor_expected";
  const notes: string[] = [];
  let capAtConditional = false;

  const knownPool = poolLevels.filter((l) => l !== "unknown");
  // Pool rows without a level: fall back to the case's qualification levels.
  const levels = knownPool.length
    ? knownPool
    : qualifications.map((q) => q.level).filter((l) => l !== "unknown");
  const diplomaOnly = levels.length > 0 && levels.every((l) => isDiplomaLevel(l));

  if (policy === "bachelor_expected" && diplomaOnly) {
    capAtConditional = true;
    notes.push(DIPLOMA_ONLY_NOTE);
  }

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
