/**
 * Engineering Manager (133211) check for a case: reads the CV jobs and the
 * saved assessor answers, runs the unchanged Professional Engineer check for
 * the chosen discipline, and evaluates the five requirements. The answers are
 * the only thing written: one FieldSource row (field "emEligibility", no
 * degree level, finalValue = JSON). No schema change; the assessment result,
 * the manual-review choice and the risk step are untouched.
 */
import { prisma } from "../lib/prisma.js";
import { checkOccupationForCase } from "./assessCase.js";
import {
  EM_ANZSCO,
  EM_FIELD,
  engineeringManagerDisciplines,
  evaluateEngineeringManager,
  parseEmAnswers,
  prerequisiteFromCheck,
  type EmAnswers,
  type EmDiscipline,
  type EmPrerequisite,
  type EngineeringManagerEvaluation,
} from "./engineeringManager.js";
import { NoSavedSubjectsError, TelecomNeedsIct60220Error } from "./manualOccupation.js";

export type EngineeringManagerCheck = EngineeringManagerEvaluation & {
  anzscoCode: string;
  title: string;
  answers: EmAnswers;
  disciplines: EmDiscipline[];
  prerequisite: EmPrerequisite;
};

/** Read-only: the CV jobs and the saved answers row. */
function loadCaseForEm(caseId: string) {
  return prisma.case.findUnique({
    where: { id: caseId },
    select: {
      id: true,
      experienceRows: {
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        select: { title: true, employer: true, start: true, end: true },
      },
      fieldSources: { where: { field: EM_FIELD, degreeLevel: null }, select: { finalValue: true } },
    },
  });
}

export type EmDeps = {
  load: typeof loadCaseForEm;
  check: (caseId: string, occupationId: string) => ReturnType<typeof checkOccupationForCase>;
};

const defaultDeps: EmDeps = {
  load: loadCaseForEm,
  check: (caseId, occupationId) => checkOccupationForCase(caseId, occupationId),
};

async function prerequisiteFor(
  caseId: string,
  discipline: EmDiscipline | null,
  check: EmDeps["check"],
): Promise<EmPrerequisite> {
  if (!discipline) return prerequisiteFromCheck(null, null);
  try {
    return prerequisiteFromCheck(discipline, await check(caseId, discipline.occupationId));
  } catch (err) {
    if (err instanceof NoSavedSubjectsError || err instanceof TelecomNeedsIct60220Error) {
      return {
        status: "not_met",
        disciplineId: discipline.occupationId,
        anzscoCode: discipline.anzscoCode,
        title: discipline.title,
        detail: err.message,
      };
    }
    throw err;
  }
}

/** Evaluate Engineering Manager for a case with the saved (or given) answers. */
export async function engineeringManagerForCase(
  caseId: string,
  answersOverride?: EmAnswers,
  deps: EmDeps = defaultDeps,
): Promise<EngineeringManagerCheck> {
  const row = await deps.load(caseId);
  if (!row) throw new Error("Case not found");
  const answers = answersOverride ?? parseEmAnswers(row.fieldSources[0]?.finalValue ?? null);
  const disciplines = engineeringManagerDisciplines();
  const discipline = disciplines.find((d) => d.occupationId === answers.disciplineId) ?? null;
  const prerequisite = await prerequisiteFor(caseId, discipline, deps.check);
  const evaluation = evaluateEngineeringManager({
    jobs: row.experienceRows.map((j) => ({ title: j.title, employer: j.employer, start: j.start, end: j.end })),
    answers,
    prerequisite,
  });
  return {
    ...evaluation,
    anzscoCode: EM_ANZSCO,
    title: "Engineering Manager",
    answers,
    disciplines,
    prerequisite,
  };
}

/** Save the assessor answers (one FieldSource row, JSON). */
export async function saveEngineeringManagerAnswers(caseId: string, answers: EmAnswers): Promise<void> {
  const existing = await prisma.fieldSource.findFirst({ where: { caseId, field: EM_FIELD, degreeLevel: null } });
  const data = { extractedValue: EM_ANZSCO, finalValue: JSON.stringify(answers) };
  if (existing) {
    await prisma.fieldSource.update({ where: { id: existing.id }, data });
  } else {
    await prisma.fieldSource.create({ data: { caseId, field: EM_FIELD, degreeLevel: null, ...data } });
  }
}