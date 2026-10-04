import { prisma } from "../lib/prisma.js";
import { assessConfig } from "../assess/config.js";
import type { AssessmentResult } from "../assess/schemas.js";
import { historicalStatsForAnzsco } from "./historical.js";
import { judgeRiskWithLlm } from "./analyzeRisk.js";
import { computeRiskScores } from "./scoreRisk.js";
import type { Competence, RiskAssessmentResult } from "./schemas.js";

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
 * Compute Step-4 risk for a chosen ANZSCO using assessment coverage,
 * historical datasheet outcomes, and related work experience.
 */
export async function runRiskAssessment(
  caseId: string,
  opts: { anzscoCode: string; title?: string },
): Promise<RiskAssessmentResult> {
  const deadlineMs = Date.now() + Math.min(assessConfig.timeoutMs, 90_000);

  const caseRow = await prisma.case.findUnique({
    where: { id: caseId },
    include: { assessment: true },
  });
  if (!caseRow?.assessment?.resultJson) {
    throw new Error("Run ANZSCO assessment before risk analysis.");
  }

  const assessment = caseRow.assessment.resultJson as StoredAssessment;
  const candidate = findCandidate(assessment, opts.anzscoCode);
  if (!candidate) {
    throw new Error(
      `ANZSCO ${opts.anzscoCode} was not found in the assessment candidates.`,
    );
  }

  const title = opts.title?.trim() || candidate.title;
  const historical = historicalStatsForAnzsco(opts.anzscoCode);
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
    workExperienceBoost,
    missingCore,
  });

  const llm = await judgeRiskWithLlm(scored, { deadlineMs });
  const result: RiskAssessmentResult = {
    ...scored,
    competence: llm.competent ? "competent" : "not_competent",
    competenceSource: "ai",
    insight: llm.insight,
  };

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
  return json.risk ?? null;
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
    competence,
    competenceSource: "manual",
  };
  await persistRisk(caseId, assessment, next);
  return next;
}
