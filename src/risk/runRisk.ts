import { prisma } from "../lib/prisma.js";
import { assessConfig } from "../assess/config.js";
import type { AssessmentResult } from "../assess/schemas.js";
import { historicalStatsForAnzsco } from "./historical.js";
import { buildPrecedentCheck, emptyPrecedentCheck } from "./precedent.js";
import {
  COMPETENCE_CONFLICT_PREFIX,
  judgeRiskWithLlm,
  withCompetence,
} from "./analyzeRisk.js";
import { computeRiskScores } from "./scoreRisk.js";
import type { Competence, RiskAssessmentResult } from "./schemas.js";

const QUAL_PRIORITY = [
  "bachelor",
  "master",
  "diploma",
  "advanced_diploma",
  "phd",
] as const;

type StoredAssessment = AssessmentResult & {
  risk?: RiskAssessmentResult;
};

function findCandidate(assessment: AssessmentResult, anzscoCode: string) {
  const code = anzscoCode.replace(/\s+/g, "");
  const fromList = assessment.candidates?.find(
    (c) => c.anzscoCode.replace(/\s+/g, "") === code,
  );
  if (fromList) return fromList;
  if (
    assessment.anzscoCode &&
    assessment.anzscoCode.replace(/\s+/g, "") === code
  ) {
    return {
      anzscoCode: assessment.anzscoCode,
      title: assessment.title ?? "Occupation",
      foundationalPct: assessment.foundationalPct,
      corePct: assessment.corePct,
      foundationalMatched: assessment.foundationalMatched,
      coreMatched: assessment.coreMatched,
      determination: assessment.determination,
      tier1Outcome: assessment.tier1Outcome,
      tier2Outcome: assessment.tier2Outcome,
      tier3GateMet: assessment.tier3GateMet,
      bandDetermination: assessment.bandDetermination,
      assessmentFlow: assessment.assessmentFlow,
      missingSubjects: assessment.missingSubjects ?? { tier1: [], tier2: [] },
      workExperienceBoost: assessment.workExperienceBoost,
      workExperienceAnalysis: null,
    };
  }
  return null;
}

async function persistRisk(
  caseId: string,
  assessmentJson: StoredAssessment,
  risk: RiskAssessmentResult,
): Promise<void> {
  const next: StoredAssessment = { ...assessmentJson, risk };
  await prisma.assessment.update({
    where: { caseId },
    data: { resultJson: next as object },
  });
}

/**
 * Why risk analysis cannot run for this assessment (null when it can).
 * Gate 1 must be open, or manual review with an assessor-selected occupation.
 */
export function riskGateBlockReason(
  assessment: Pick<AssessmentResult, "gate1" | "assessorSelected">,
): string | null {
  const gate = assessment.gate1;
  if (!gate || gate.result === "open") return null;
  if (gate.result === "manual_review" && assessment.assessorSelected) return null;
  return gate.result === "not_eligible"
    ? "Risk analysis is not available: the assessment Gate 1 result is not eligible."
    : "Risk analysis is not available: the assessment Gate 1 result needs manual review.";
}

/**
 * Compute Step 5 risk for a chosen ANZSCO: weighted overall academic alignment
 * score (fundamental / core / historical, see riskBands.config.ts) mapped to
 * the risk category. Work experience is a note only.
 */
export async function runRiskAssessment(
  caseId: string,
  opts: { anzscoCode: string; title?: string },
): Promise<RiskAssessmentResult> {
  const deadlineMs = Date.now() + Math.min(assessConfig.timeoutMs, 90_000);

  const caseRow = await prisma.case.findUnique({
    where: { id: caseId },
    include: { assessment: true, qualifications: true },
  });
  if (!caseRow?.assessment?.resultJson) {
    throw new Error("Run ANZSCO assessment before risk analysis.");
  }

  const assessment = caseRow.assessment.resultJson as StoredAssessment;
  const blocked = riskGateBlockReason(assessment);
  if (blocked) throw new Error(blocked);
  const candidate = findCandidate(assessment, opts.anzscoCode);
  if (!candidate) {
    throw new Error(
      `ANZSCO ${opts.anzscoCode} was not found in the assessment candidates.`,
    );
  }

  const title = opts.title?.trim() || candidate.title;
  const historical = historicalStatsForAnzsco(opts.anzscoCode);

  const quals = [...(caseRow.qualifications ?? [])].sort((a, b) => {
    const ia = QUAL_PRIORITY.indexOf(
      a.degreeLevel as (typeof QUAL_PRIORITY)[number],
    );
    const ib = QUAL_PRIORITY.indexOf(
      b.degreeLevel as (typeof QUAL_PRIORITY)[number],
    );
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const primaryQual = quals[0] ?? null;
  const precedent = buildPrecedentCheck({
    anzscoCode: candidate.anzscoCode,
    occupationTitle: title,
    degreeTitle: primaryQual?.degreeTitle ?? null,
    university: primaryQual?.institution ?? null,
    country: primaryQual?.country ?? null,
  });

  const workExperienceBoost = Boolean(
    candidate.workExperienceBoost ??
      candidate.workExperienceAnalysis?.related ??
      assessment.workExperienceBoost,
  );
  const missingCore = candidate.missingSubjects?.tier2 ?? [];

  const scored = computeRiskScores({
    anzscoCode: candidate.anzscoCode,
    title,
    fundamentalPct: candidate.foundationalPct,
    corePct: candidate.corePct,
    historical,
    precedent,
    workExperienceBoost,
    missingCore,
    assessmentFlow: candidate.assessmentFlow,
    vocational: "vocational" in candidate ? candidate.vocational : null,
  });

  const llm = await judgeRiskWithLlm(scored, { deadlineMs });
  const result: RiskAssessmentResult = withCompetence(scored, llm);

  await persistRisk(caseId, assessment, result);

  if (title) {
    await prisma.case.update({
      where: { id: caseId },
      data: { targetOccupation: `${title} (${candidate.anzscoCode})` },
    });
  }

  return result;
}

export async function getStoredRisk(
  caseId: string,
): Promise<RiskAssessmentResult | null> {
  const row = await prisma.assessment.findUnique({ where: { caseId } });
  if (!row?.resultJson) return null;
  const json = row.resultJson as StoredAssessment;
  if (!json.risk) return null;
  return {
    ...json.risk,
    precedent: json.risk.precedent ?? emptyPrecedentCheck(),
  };
}

export async function patchRiskCompetence(
  caseId: string,
  competence: Competence,
): Promise<RiskAssessmentResult> {
  const row = await prisma.assessment.findUnique({ where: { caseId } });
  if (!row?.resultJson) {
    throw new Error("No assessment found.");
  }
  const assessment = row.resultJson as StoredAssessment;
  if (!assessment.risk) {
    throw new Error("No risk result yet. Run risk analysis first.");
  }
  const next: RiskAssessmentResult = {
    ...assessment.risk,
    precedent: assessment.risk.precedent ?? emptyPrecedentCheck(),
    competence,
    competenceSource: "manual",
    // The assessor has reviewed: drop the AI conflict note.
    competenceConflict: false,
    riskNotes: (assessment.risk.riskNotes ?? []).filter(
      (n) => !n.startsWith(COMPETENCE_CONFLICT_PREFIX),
    ),
  };
  await persistRisk(caseId, assessment, next);
  return next;
}
