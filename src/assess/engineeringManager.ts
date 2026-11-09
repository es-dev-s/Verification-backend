/**
 * Engineering Manager (ANZSCO 133211): manual eligibility check.
 *
 * Never suggested by the assessment (no subject rubric). The assessor picks it
 * in "Check an ANZSCO" and answers a few questions; this module turns those
 * answers plus the CV jobs into the five requirements:
 *   1. Meets the Professional Engineer criteria (discipline check, unchanged).
 *   2. 5 years at professional level before management, 2 years as a manager.
 *   3. Proper managerial role (assessor).
 *   4. The people reporting to the client are managers (assessor).
 *   5. RSE assessment applied (assessor).
 * A Project Manager / Project Engineer is assessed as an engineering
 * professional instead (Professional Engineer category, Skill Level 1).
 * Pure: no database, no AI.
 */
import { z } from "zod";
import type { OccupationCheck } from "./assessCase.js";
import { trackForAnzsco } from "./gate1.js";
import { listAcademicOccupations } from "./loadRubric.js";
import { monthIndex, unionMonths } from "./specialisation.js";

export const EM_ANZSCO = "133211";
export const EM_OCCUPATION_ID = "engineering-manager";
/** FieldSource row (no degree level) holding the assessor answers as JSON. */
export const EM_FIELD = "emEligibility";
export const EM_PROFESSIONAL_YEARS = 5;
export const EM_MANAGER_YEARS = 2;
export const EM_REDIRECT_MESSAGE =
  "Assess as an engineering professional (Professional Engineer category, Skill Level 1).";

export const EM_JOB_LEVELS = ["professional", "manager", "project", "other"] as const;
export type EmJobLevel = (typeof EM_JOB_LEVELS)[number];

export const emAnswersSchema = z.object({
  /** Underlying Professional Engineer occupation id (e.g. civil-engineer). */
  disciplineId: z.string().trim().max(120).nullable().default(null),
  /** Level per CV job, keyed by jobKey(); missing keys use the title guess. */
  jobLevels: z.record(z.string().max(600), z.enum(EM_JOB_LEVELS)).default({}),
  managerialRole: z.boolean().nullable().default(null),
  managersReport: z.boolean().nullable().default(null),
  rseApplied: z.boolean().nullable().default(null),
  /** Project Manager / Project Engineer: assessor confirms the redirect. */
  redirectConfirmed: z.boolean().nullable().default(null),
});
export type EmAnswers = z.infer<typeof emAnswersSchema>;

export const EMPTY_EM_ANSWERS: EmAnswers = {
  disciplineId: null,
  jobLevels: {},
  managerialRole: null,
  managersReport: null,
  rseApplied: null,
  redirectConfirmed: null,
};

/** Saved JSON to answers (empty answers when missing or unreadable). */
export function parseEmAnswers(raw: string | null | undefined): EmAnswers {
  if (!raw) return { ...EMPTY_EM_ANSWERS, jobLevels: {} };
  try {
    const r = emAnswersSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : { ...EMPTY_EM_ANSWERS, jobLevels: {} };
  } catch {
    return { ...EMPTY_EM_ANSWERS, jobLevels: {} };
  }
}

export type EmDiscipline = { occupationId: string; anzscoCode: string; title: string };

/** Professional Engineer occupations with a subject rubric (the discipline picks). */
export function engineeringManagerDisciplines(): EmDiscipline[] {
  return listAcademicOccupations()
    .filter((o) => String(o.anzsco) !== EM_ANZSCO && trackForAnzsco(String(o.anzsco)) === "professional_engineer")
    .map((o) => ({ occupationId: o.id, anzscoCode: String(o.anzsco), title: o.title }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

export type EmJobInput = {
  title: string | null;
  employer: string | null;
  start: string | null;
  end: string | null;
};

/** Stable key for a CV job (experience rows are re-created on save, ids are not stable). */
export function jobKey(job: EmJobInput): string {
  const norm = (s: string | null) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return [norm(job.title), norm(job.employer), norm(job.start)].join("|");
}

const PROJECT_TITLE = /\bproject\s+(manager|engineer|management|engineering)\b/i;
const MANAGER_TITLE =
  /\b(manager|head of|director|chief|general manager|gm|vice[\s-]?president|vp|superintendent)\b/i;

/** Default level from the job title (the assessor can change it). */
export function guessJobLevel(title: string | null | undefined): EmJobLevel {
  const t = (title ?? "").trim();
  if (PROJECT_TITLE.test(t)) return "project";
  if (MANAGER_TITLE.test(t)) return "manager";
  return "professional";
}

const PART_TIME = /part[\s-]?time/i;

export type EmJob = EmJobInput & {
  key: string;
  suggestedLevel: EmJobLevel;
  level: EmJobLevel;
  partTime: boolean;
  /** Full-time-equivalent years (null when the dates cannot be read). */
  years: number | null;
};

type Span = { a: number; b: number; fte: number };

function spanOf(job: EmJobInput, now: Date): Span | null {
  const a = monthIndex(job.start, now);
  const bEnd = monthIndex(job.end, now, true);
  if (a == null || bEnd == null || bEnd < a) return null;
  return { a, b: bEnd + 1, fte: PART_TIME.test(job.title ?? "") ? 0.5 : 1 };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** FTE years of overlapping spans (overlaps counted once; part-time at half). */
function fteYears(spans: Span[]): number {
  const full = unionMonths(spans.filter((s) => s.fte === 1).map((s) => [s.a, s.b] as [number, number]));
  const part = unionMonths(spans.filter((s) => s.fte !== 1).map((s) => [s.a, s.b] as [number, number]));
  return round1((full + 0.5 * part) / 12);
}

export type EmPrerequisite = {
  status: "met" | "not_met" | "pending";
  disciplineId: string | null;
  anzscoCode: string | null;
  title: string | null;
  detail: string;
};

/** Professional Engineer prerequisite from the unchanged discipline check. */
export function prerequisiteFromCheck(discipline: EmDiscipline | null, check: OccupationCheck | null): EmPrerequisite {
  if (!discipline) {
    return { status: "pending", disciplineId: null, anzscoCode: null, title: null, detail: "Pick the engineering discipline." };
  }
  const base = { disciplineId: discipline.occupationId, anzscoCode: discipline.anzscoCode, title: discipline.title };
  if (!check) return { ...base, status: "not_met", detail: `Matching is not available for ${discipline.title}.` };
  const trackOk = check.trackOpen && check.track === "professional_engineer";
  const matchOk = check.candidate.recommended;
  const pct = Math.round(check.candidate.confidenceScore);
  const parts = [
    trackOk ? "Gate 1 Professional Engineer track open" : "Gate 1 did not open the Professional Engineer track",
    matchOk ? `subject match passes (${pct}%)` : `subject match does not pass (${pct}%)`,
  ];
  return { ...base, status: trackOk && matchOk ? "met" : "not_met", detail: `${discipline.title}: ${parts.join(", ")}.` };
}

export type EmCheckStatus = "met" | "not_met" | "pending";
export type EmRequirement = {
  id: "professional_engineer" | "experience" | "managerial_role" | "managers_report" | "rse_applied";
  label: string;
  status: EmCheckStatus;
  detail: string | null;
};

export type EmOutcome = "qualified" | "not_qualified" | "redirect" | "pending";

export type EngineeringManagerEvaluation = {
  outcome: EmOutcome;
  message: string;
  /** Missing requirements with the year shortfall where it applies. */
  missing: string[];
  checks: EmRequirement[];
  jobs: EmJob[];
  years: { professional: number; manager: number };
  /** True when the jobs are Project Manager / Project Engineer, not manager level. */
  redirectSuggested: boolean;
};

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** "3.2 of 5 years, short by 1.8" (null when the need is met). */
export function yearShortfall(have: number, need: number): string | null {
  if (have >= need) return null;
  return `${fmt(have)} of ${fmt(need)} years, short by ${fmt(round1(need - have))}`;
}

function confirmation(value: boolean | null): EmCheckStatus {
  return value === true ? "met" : value === false ? "not_met" : "pending";
}

export function evaluateEngineeringManager(input: {
  jobs: EmJobInput[];
  answers: EmAnswers;
  prerequisite: EmPrerequisite;
  now?: Date;
}): EngineeringManagerEvaluation {
  const now = input.now ?? new Date();
  const { answers } = input;
  const withSpans = input.jobs.map((j) => {
    const key = jobKey(j);
    const suggestedLevel = guessJobLevel(j.title);
    const level = answers.jobLevels[key] ?? suggestedLevel;
    const span = spanOf(j, now);
    const job: EmJob = {
      ...j,
      key,
      suggestedLevel,
      level,
      partTime: PART_TIME.test(j.title ?? ""),
      years: span ? fteYears([span]) : null,
    };
    return { job, span };
  });
  const jobs = withSpans.map((x) => x.job);

  const managerSpans = withSpans.filter((x) => x.job.level === "manager" && x.span).map((x) => x.span!);
  const firstManagerStart = managerSpans.length ? Math.min(...managerSpans.map((s) => s.a)) : null;
  // Professional-level work (project roles included) counted before the first manager job.
  const professionalSpans = withSpans
    .filter((x) => (x.job.level === "professional" || x.job.level === "project") && x.span)
    .map((x) => ({ ...x.span!, b: firstManagerStart == null ? x.span!.b : Math.min(x.span!.b, firstManagerStart) }))
    .filter((s) => s.b > s.a);
  const years = { professional: fteYears(professionalSpans), manager: fteYears(managerSpans) };

  const redirectSuggested = jobs.some((j) => j.level === "project") && !jobs.some((j) => j.level === "manager");

  const proShort = yearShortfall(years.professional, EM_PROFESSIONAL_YEARS);
  const mgrShort = yearShortfall(years.manager, EM_MANAGER_YEARS);
  const experienceMissing = [
    proShort ? `professional level: ${proShort}` : null,
    mgrShort ? `manager level: ${mgrShort}` : null,
  ].filter((s): s is string => Boolean(s));

  const checks: EmRequirement[] = [
    {
      id: "professional_engineer",
      label: "Meets the Professional Engineer criteria",
      status: input.prerequisite.status,
      detail: input.prerequisite.detail,
    },
    {
      id: "experience",
      label: `${EM_PROFESSIONAL_YEARS} years as a professional engineer, then ${EM_MANAGER_YEARS} years as a manager`,
      status: experienceMissing.length ? "not_met" : "met",
      detail: experienceMissing.length
        ? experienceMissing.map((s) => s[0]!.toUpperCase() + s.slice(1)).join("; ")
        : `Professional level ${fmt(years.professional)} years, manager level ${fmt(years.manager)} years.`,
    },
    {
      id: "managerial_role",
      label: "Proper managerial role",
      status: confirmation(answers.managerialRole),
      detail: null,
    },
    {
      id: "managers_report",
      label: "People reporting to the client are managers",
      status: confirmation(answers.managersReport),
      detail: null,
    },
    {
      id: "rse_applied",
      label: "RSE assessment applied",
      status: confirmation(answers.rseApplied),
      detail: null,
    },
  ];

  if (redirectSuggested && answers.redirectConfirmed === true) {
    return { outcome: "redirect", message: EM_REDIRECT_MESSAGE, missing: [], checks, jobs, years, redirectSuggested };
  }
  if (redirectSuggested && answers.redirectConfirmed == null) {
    return {
      outcome: "pending",
      message: "Project Manager / Project Engineer role: confirm whether to assess as an engineering professional.",
      missing: [],
      checks,
      jobs,
      years,
      redirectSuggested,
    };
  }

  const missing: string[] = [];
  for (const c of checks) {
    if (c.status !== "not_met") continue;
    if (c.id === "experience") missing.push(...experienceMissing.map((s) => `Experience at ${s}`));
    else missing.push(c.label);
  }
  if (missing.length) {
    return {
      outcome: "not_qualified",
      message: "Not qualified as an Engineering Manager.",
      missing,
      checks,
      jobs,
      years,
      redirectSuggested,
    };
  }
  if (checks.some((c) => c.status === "pending")) {
    return {
      outcome: "pending",
      message: "Answer the open items to finish the check.",
      missing: [],
      checks,
      jobs,
      years,
      redirectSuggested,
    };
  }
  return {
    outcome: "qualified",
    message: "Qualified as an Engineering Manager: all five requirements are met.",
    missing: [],
    checks,
    jobs,
    years,
    redirectSuggested,
  };
}