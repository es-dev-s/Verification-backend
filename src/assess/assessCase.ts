import { prisma } from "../lib/prisma.js";
import { assessConfig } from "./config.js";
import { judgeWorkExperienceBoost } from "./experienceBoost.js";
import { buildExplanationFallback, writeExplanation } from "./explain.js";
import {
  degreeLevelToQualification,
  extractSubjectsFromTranscripts,
  hashAssessmentInput,
  type TranscriptSource,
} from "./extractSubjects.js";
import {
  flattenRubricSubjects,
  loadRubric,
  scoringSubjects,
  type Rubric,
} from "./loadRubric.js";
import { matchSubjects, matchSubjectsSync } from "./matchSubjects.js";
import type {
  AnzscoCandidate,
  AssessmentResult,
  ExtractedSubjectRow,
  MissingSubjectsByTier,
  QualificationType,
  SubjectMatch,
  TranscriptSourceInfo,
} from "./schemas.js";
import { needsMastersFallback, scoreAssessment } from "./score.js";

export type AssessCaseOpts = {
  /** Force re-extract even if hash matches. */
  force?: boolean;
  /** Skip LLM (tests / offline). Requires pre-persisted subjects or injected rows. */
  useLlm?: boolean;
  /** Inject extracted subjects (skips LLM extract). */
  injectedSubjects?: ExtractedSubjectRow[];
};

/**
 * Full assessment pipeline for a case → ANZSCO 233111 or no match.
 */
export async function assessCase(
  caseId: string,
  opts?: AssessCaseOpts,
): Promise<AssessmentResult> {
  const deadlineMs = Date.now() + assessConfig.timeoutMs;
  const useLlm = opts?.useLlm !== false;
  const rubric = loadRubric("233111");
  const rubricSubjects = flattenRubricSubjects(rubric);

  const caseRow = await prisma.case.findUnique({
    where: { id: caseId },
    include: {
      documents: true,
      experienceRows: { orderBy: { sortOrder: "asc" } },
      assessment: true,
      extractedSubjects: { orderBy: { sortOrder: "asc" } },
    },
  });
  if (!caseRow) throw new Error("Case not found");

  const transcripts = caseRow.documents.filter(
    (d) => d.type === "TRANSCRIPT" && d.status === "DONE" && d.text?.trim(),
  );
  const cvDoc = caseRow.documents.find(
    (d) => d.type === "CV" && d.status === "DONE",
  );
  const cvText = cvDoc?.text ?? null;

  if (!transcripts.length && !opts?.injectedSubjects?.length && !caseRow.extractedSubjects.length) {
    return emptyNoMatch(
      "No transcript text available to assess. Upload and extract a transcript first.",
    );
  }

  const inputHash = hashAssessmentInput(
    transcripts.map((t) => ({ id: t.id, text: t.text ?? "" })),
    cvText,
  );

  // Cache hit
  if (
    !opts?.force &&
    !opts?.injectedSubjects &&
    caseRow.assessment &&
    caseRow.assessment.inputHash === inputHash &&
    caseRow.assessment.resultJson
  ) {
    const cached = caseRow.assessment.resultJson as unknown as AssessmentResult;
    if (!cached.extractedSubjects?.length && caseRow.extractedSubjects.length) {
      cached.extractedSubjects = caseRow.extractedSubjects.map((s) => ({
        name: s.name,
        code: s.code,
        credits: s.credits,
        grade: s.grade,
        yearOrSemester: s.yearOrSemester,
        qualification: s.qualification as QualificationType,
        sourceSnippet: s.sourceSnippet,
        isRepeat: s.isRepeat,
      }));
    }
    return cached;
  }

  // Step 1 — extract (or reuse persisted / injected)
  let extracted: ExtractedSubjectRow[];
  if (opts?.injectedSubjects) {
    extracted = opts.injectedSubjects;
  } else if (
    !opts?.force &&
    caseRow.extractedSubjects.length &&
    caseRow.assessment?.inputHash === inputHash
  ) {
    extracted = caseRow.extractedSubjects.map((s) => ({
      name: s.name,
      code: s.code,
      credits: s.credits,
      grade: s.grade,
      yearOrSemester: s.yearOrSemester,
      qualification: s.qualification as QualificationType,
      sourceSnippet: s.sourceSnippet,
      isRepeat: s.isRepeat,
    }));
  } else if (useLlm && transcripts.length) {
    const sources: TranscriptSource[] = transcripts.map((t) => ({
      documentId: t.id,
      text: t.text!,
      degreeLevelHint: degreeLevelToQualification(t.degreeLevel),
    }));
    extracted = await extractSubjectsFromTranscripts(sources, { deadlineMs });
    await persistExtractedSubjects(caseId, extracted, transcripts);
  } else if (caseRow.extractedSubjects.length) {
    extracted = caseRow.extractedSubjects.map((s) => ({
      name: s.name,
      code: s.code,
      credits: s.credits,
      grade: s.grade,
      yearOrSemester: s.yearOrSemester,
      qualification: s.qualification as QualificationType,
      sourceSnippet: s.sourceSnippet,
      isRepeat: s.isRepeat,
    }));
  } else {
    return emptyNoMatch(
      "Could not extract subjects from the transcript (LLM unavailable and no cached subjects).",
    );
  }

  // Step 5 — work experience boost (positive only; heuristic by default)
  const boost = await judgeWorkExperienceBoost(
    caseRow.experienceRows,
    cvText,
    {
      useLlm: useLlm && assessConfig.llmWorkExperience,
      deadlineMs,
    },
  );

  // Step 4 — bachelors first, then masters if core insufficient
  const bachelorRows = extracted.filter((s) => s.qualification === "bachelor");
  const masterRows = extracted.filter((s) => s.qualification === "master");
  const unknownRows = extracted.filter((s) => s.qualification === "unknown");

  // Prefer bachelor + unknown first (unknown often bachelor when single degree)
  let pool = [...bachelorRows, ...unknownRows];
  let qualificationsUsed: QualificationType[] = pool.length
    ? [...new Set(pool.map((p) => p.qualification))]
    : ["unknown"];

  if (!pool.length) {
    pool = extracted;
    qualificationsUsed = [...new Set(extracted.map((e) => e.qualification))];
  }

  const useLlmMatch = useLlm && assessConfig.llmUnclearMatches;
  let matchResult = useLlmMatch
    ? await matchSubjects(pool, rubricSubjects, {
        useLlm: true,
        deadlineMs,
      })
    : matchSubjectsSync(pool, rubricSubjects);

  let scored = scoreAssessment({
    matches: matchResult.matches,
    qualificationsUsed,
    workExperienceBoost: boost.related,
    rubric,
  });

  let mastersFallbackUsed = false;

  // If core weak and masters exist, include masters and re-score
  if (
    masterRows.length &&
    scored.tier2Outcome &&
    needsMastersFallback(scored.tier2Outcome)
  ) {
    pool = [...bachelorRows, ...unknownRows, ...masterRows];
    qualificationsUsed = [
      ...new Set(pool.map((p) => p.qualification)),
    ] as QualificationType[];
    matchResult = useLlmMatch
      ? await matchSubjects(pool, rubricSubjects, {
          useLlm: true,
          deadlineMs,
        })
      : matchSubjectsSync(pool, rubricSubjects);
    scored = scoreAssessment({
      matches: matchResult.matches,
      qualificationsUsed,
      workExperienceBoost: boost.related,
      rubric,
    });
    mastersFallbackUsed = true;
  }

  const unmatched = matchResult.unmatched.map((u) => ({
    name: u.name,
    code: u.code ?? null,
    qualification: u.qualification as QualificationType,
  }));

  // Keep positive matches + none rows that are unmatched for UI clarity
  const matches = dedupeMatchRows(matchResult.matches);
  const missingSubjects = computeMissingSubjects(matches, rubric);
  const transcriptSource = buildTranscriptSource(
    qualificationsUsed,
    mastersFallbackUsed,
  );
  const candidate = buildCandidate(
    rubric,
    scored,
    matches,
    missingSubjects,
    unmatched,
  );

  const result: AssessmentResult = {
    anzscoCode: scored.anzscoCode,
    title: scored.title,
    recommended: scored.recommended,
    confidence: scored.confidence,
    determination: scored.determination,
    foundationalMatched: scored.foundationalMatched,
    foundationalExpected: scored.foundationalExpected,
    foundationalPct: scored.foundationalPct,
    coreMatched: scored.coreMatched,
    coreExpected: scored.coreExpected,
    corePct: scored.corePct,
    tier1Outcome: scored.tier1Outcome,
    tier2Outcome: scored.tier2Outcome,
    tier3GateMet: scored.tier3GateMet,
    workExperienceBoost: boost.related,
    qualificationsUsed,
    matches,
    unmatched,
    missingSubjects,
    transcriptSource,
    mastersFallbackUsed,
    candidates: [candidate],
    extractedSubjects: extracted,
    explanation: "",
  };

  result.explanation = await writeExplanation(result, {
    useLlm: useLlm && assessConfig.llmExplanation,
    deadlineMs,
  });

  await prisma.assessment.upsert({
    where: { caseId },
    create: {
      caseId,
      inputHash,
      anzscoCode: result.anzscoCode,
      confidence: result.confidence,
      determination: result.determination,
      recommended: result.recommended,
      foundationalMatched: result.foundationalMatched,
      foundationalExpected: result.foundationalExpected,
      foundationalPct: result.foundationalPct,
      coreMatched: result.coreMatched,
      coreExpected: result.coreExpected,
      corePct: result.corePct,
      tier1Outcome: result.tier1Outcome,
      tier2Outcome: result.tier2Outcome,
      tier3GateMet: result.tier3GateMet,
      workExperienceBoost: result.workExperienceBoost,
      qualificationsUsed: result.qualificationsUsed,
      explanation: result.explanation,
      resultJson: result as object,
    },
    update: {
      inputHash,
      anzscoCode: result.anzscoCode,
      confidence: result.confidence,
      determination: result.determination,
      recommended: result.recommended,
      foundationalMatched: result.foundationalMatched,
      foundationalExpected: result.foundationalExpected,
      foundationalPct: result.foundationalPct,
      coreMatched: result.coreMatched,
      coreExpected: result.coreExpected,
      corePct: result.corePct,
      tier1Outcome: result.tier1Outcome,
      tier2Outcome: result.tier2Outcome,
      tier3GateMet: result.tier3GateMet,
      workExperienceBoost: result.workExperienceBoost,
      qualificationsUsed: result.qualificationsUsed,
      explanation: result.explanation,
      resultJson: result as object,
    },
  });

  // Also set target occupation when recommended
  if (result.recommended && result.title) {
    await prisma.case.update({
      where: { id: caseId },
      data: { targetOccupation: `${result.title} (${result.anzscoCode})` },
    });
  }

  return result;
}

function emptyNoMatch(explanation: string): AssessmentResult {
  const rubric = loadRubric("233111");
  const missingSubjects: MissingSubjectsByTier = {
    tier1: scoringSubjects(rubric, "tier1").map((s) => s.name),
    tier2: scoringSubjects(rubric, "tier2").map((s) => s.name),
  };
  const candidate: AnzscoCandidate = {
    anzscoCode: rubric.anzscoCode,
    title: rubric.title,
    foundationalMatched: 0,
    foundationalExpected: rubric.tiers.tier1.scoreDenominator,
    foundationalPct: 0,
    coreMatched: 0,
    coreExpected: rubric.tiers.tier2.scoreDenominator,
    corePct: 0,
    tier3GateMet: false,
    matches: [],
    missingSubjects,
    unmatched: [],
  };
  return {
    anzscoCode: null,
    title: null,
    recommended: false,
    confidence: null,
    determination: "no_match",
    foundationalMatched: 0,
    foundationalExpected: rubric.tiers.tier1.scoreDenominator,
    foundationalPct: 0,
    coreMatched: 0,
    coreExpected: rubric.tiers.tier2.scoreDenominator,
    corePct: 0,
    tier1Outcome: null,
    tier2Outcome: null,
    tier3GateMet: false,
    workExperienceBoost: false,
    qualificationsUsed: [],
    matches: [],
    unmatched: [],
    missingSubjects,
    transcriptSource: {
      kind: "unknown",
      label: "Matched using: no transcript available",
    },
    mastersFallbackUsed: false,
    candidates: [candidate],
    extractedSubjects: [],
    explanation,
  };
}

async function persistExtractedSubjects(
  caseId: string,
  rows: ExtractedSubjectRow[],
  transcripts: Array<{ id: string }>,
) {
  await prisma.extractedSubject.deleteMany({ where: { caseId } });
  if (!rows.length) return;
  const docId = transcripts[0]?.id ?? null;
  await prisma.extractedSubject.createMany({
    data: rows.map((r, i) => ({
      caseId,
      documentId: docId,
      name: r.name,
      code: r.code ?? null,
      credits: r.credits ?? null,
      grade: r.grade ?? null,
      yearOrSemester: r.yearOrSemester ?? null,
      qualification: r.qualification,
      sourceSnippet: r.sourceSnippet ?? null,
      isRepeat: r.isRepeat ?? false,
      sortOrder: i,
    })),
  });
}

function dedupeMatchRows(matches: SubjectMatch[]): SubjectMatch[] {
  const seen = new Set<string>();
  const out: SubjectMatch[] = [];
  for (const m of matches) {
    const key = `${m.transcriptName}|${m.rubricSubject ?? ""}|${m.method}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

function computeMissingSubjects(
  matches: SubjectMatch[],
  rubric: Rubric,
): MissingSubjectsByTier {
  const covered = new Set(
    matches
      .filter((m) => m.rubricSubject && m.method !== "none")
      .map((m) => m.rubricSubject!),
  );
  return {
    tier1: scoringSubjects(rubric, "tier1")
      .map((s) => s.name)
      .filter((name) => !covered.has(name)),
    tier2: scoringSubjects(rubric, "tier2")
      .map((s) => s.name)
      .filter((name) => !covered.has(name)),
  };
}

function buildTranscriptSource(
  qualificationsUsed: QualificationType[],
  mastersFallbackUsed: boolean,
): TranscriptSourceInfo {
  if (mastersFallbackUsed) {
    return {
      kind: "master_fallback",
      label:
        "Matched using: Master's transcript (fallback — Bachelor's core coverage was below threshold)",
    };
  }
  const hasBachelor = qualificationsUsed.includes("bachelor");
  const hasMaster = qualificationsUsed.includes("master");
  if (hasBachelor && !hasMaster) {
    return {
      kind: "bachelor",
      label: "Matched using: Bachelor's transcript",
    };
  }
  if (hasMaster && !hasBachelor) {
    return {
      kind: "master",
      label: "Matched using: Master's transcript",
    };
  }
  if (hasBachelor && hasMaster) {
    return {
      kind: "mixed",
      label: "Matched using: Bachelor's and Master's transcript subjects",
    };
  }
  return {
    kind: "unknown",
    label: "Matched using: transcript subjects (degree level not specified)",
  };
}

function buildCandidate(
  rubric: Rubric,
  scored: {
    foundationalMatched: number;
    foundationalExpected: number;
    foundationalPct: number;
    coreMatched: number;
    coreExpected: number;
    corePct: number;
    tier3GateMet: boolean;
  },
  matches: SubjectMatch[],
  missingSubjects: MissingSubjectsByTier,
  unmatched: AnzscoCandidate["unmatched"],
): AnzscoCandidate {
  return {
    anzscoCode: rubric.anzscoCode,
    title: rubric.title,
    foundationalMatched: scored.foundationalMatched,
    foundationalExpected: scored.foundationalExpected,
    foundationalPct: scored.foundationalPct,
    coreMatched: scored.coreMatched,
    coreExpected: scored.coreExpected,
    corePct: scored.corePct,
    tier3GateMet: scored.tier3GateMet,
    matches,
    missingSubjects,
    unmatched,
  };
}

/** Pure scoring path for unit tests (no DB / LLM). */
export function assessExtractedSubjects(
  extracted: ExtractedSubjectRow[],
  opts?: { workExperienceBoost?: boolean },
): AssessmentResult {
  const rubric = loadRubric("233111");
  const rubricSubjects = flattenRubricSubjects(rubric);

  const bachelorRows = extracted.filter((s) => s.qualification === "bachelor");
  const masterRows = extracted.filter((s) => s.qualification === "master");
  const unknownRows = extracted.filter((s) => s.qualification === "unknown");

  let pool = [...bachelorRows, ...unknownRows];
  if (!pool.length) pool = extracted;

  let { matches, unmatched } = matchSubjectsSync(pool, rubricSubjects);
  let qualificationsUsed = [
    ...new Set(pool.map((p) => p.qualification)),
  ] as QualificationType[];

  let scored = scoreAssessment({
    matches,
    qualificationsUsed,
    workExperienceBoost: opts?.workExperienceBoost ?? false,
    rubric,
  });

  let mastersFallbackUsed = false;
  if (
    masterRows.length &&
    scored.tier2Outcome &&
    needsMastersFallback(scored.tier2Outcome)
  ) {
    pool = [...bachelorRows, ...unknownRows, ...masterRows];
    qualificationsUsed = [
      ...new Set(pool.map((p) => p.qualification)),
    ] as QualificationType[];
    ({ matches, unmatched } = matchSubjectsSync(pool, rubricSubjects));
    scored = scoreAssessment({
      matches,
      qualificationsUsed,
      workExperienceBoost: opts?.workExperienceBoost ?? false,
      rubric,
    });
    mastersFallbackUsed = true;
  }

  const deduped = dedupeMatchRows(matches);
  const unmatchedRows = unmatched.map((u) => ({
    name: u.name,
    code: u.code ?? null,
    qualification: u.qualification as QualificationType,
  }));
  const missingSubjects = computeMissingSubjects(deduped, rubric);
  const transcriptSource = buildTranscriptSource(
    qualificationsUsed,
    mastersFallbackUsed,
  );
  const candidate = buildCandidate(
    rubric,
    scored,
    deduped,
    missingSubjects,
    unmatchedRows,
  );

  const result: AssessmentResult = {
    anzscoCode: scored.anzscoCode,
    title: scored.title,
    recommended: scored.recommended,
    confidence: scored.confidence,
    determination: scored.determination,
    foundationalMatched: scored.foundationalMatched,
    foundationalExpected: scored.foundationalExpected,
    foundationalPct: scored.foundationalPct,
    coreMatched: scored.coreMatched,
    coreExpected: scored.coreExpected,
    corePct: scored.corePct,
    tier1Outcome: scored.tier1Outcome,
    tier2Outcome: scored.tier2Outcome,
    tier3GateMet: scored.tier3GateMet,
    workExperienceBoost: opts?.workExperienceBoost ?? false,
    qualificationsUsed,
    matches: deduped,
    unmatched: unmatchedRows,
    missingSubjects,
    transcriptSource,
    mastersFallbackUsed,
    candidates: [candidate],
    extractedSubjects: extracted,
    explanation: "",
  };
  result.explanation = buildExplanationFallback(result);
  return result;
}
