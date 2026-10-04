import { prisma } from "../lib/prisma.js";
import { assessConfig } from "./config.js";
import {
  analyzeWorkExperienceForCandidates,
  type OccupationWorkJudgement,
} from "./experienceBoost.js";
import { buildExplanationFallback, writeExplanation } from "./explain.js";
import {
  degreeLevelToQualification,
  extractSubjectsFromTranscripts,
  hashAssessmentInput,
  type TranscriptSource,
} from "./extractSubjects.js";
import {
  flattenRubricSubjects,
  loadAllAcademicRubrics,
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
  WorkExperienceCandidateAnalysis,
} from "./schemas.js";
import {
  needsMastersFallback,
  scoreAssessment,
  type ScoreResult,
} from "./score.js";

export type AssessCaseOpts = {
  /** Force re-extract even if hash matches. */
  force?: boolean;
  /** Skip LLM (tests / offline). Requires pre-persisted subjects or injected rows. */
  useLlm?: boolean;
  /** Inject extracted subjects (skips LLM extract). */
  injectedSubjects?: ExtractedSubjectRow[];
  /**
   * Score only this occupation id or ANZSCO (tests / targeted re-run).
   * Default: score all academic occupations and return top candidates.
   */
  occupationId?: string;
};

type ScoredOccupation = {
  rubric: Rubric;
  scored: ScoreResult;
  matches: SubjectMatch[];
  unmatched: ExtractedSubjectRow[];
  qualificationsUsed: QualificationType[];
  mastersFallbackUsed: boolean;
  workExperienceBoost: boolean;
  /** Academic-only score before work boost (for UI before→after %). */
  confidenceScoreBefore: number;
  workExperienceAnalysis: WorkExperienceCandidateAnalysis | null;
};

/**
 * Full assessment pipeline: extract subjects once, score against every
 * academic ANZSCO rubric, return the best match + top-N candidates.
 */
export async function assessCase(
  caseId: string,
  opts?: AssessCaseOpts,
): Promise<AssessmentResult> {
  const deadlineMs = Date.now() + assessConfig.timeoutMs;
  const useLlm = opts?.useLlm !== false;

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

  if (
    !transcripts.length &&
    !opts?.injectedSubjects?.length &&
    !caseRow.extractedSubjects.length
  ) {
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
    !opts?.occupationId &&
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

  const rubrics = opts?.occupationId
    ? [loadRubric(opts.occupationId)]
    : loadAllAcademicRubrics();

  // Academic sync-match every occupation first (no work experience in ranking).
  const scoredAll: ScoredOccupation[] = [];
  for (const rubric of rubrics) {
    scoredAll.push(
      scoreOccupation(extracted, rubric, {
        workExperienceBoost: false,
      }),
    );
  }

  scoredAll.sort(compareScoredOccupations);
  let top = scoredAll.slice(0, assessConfig.maxCandidates);

  // Optional: refine the best occupation with LLM unclear subject matching
  const best = top[0];
  if (best && useLlm && assessConfig.llmUnclearMatches) {
    const refined = await scoreOccupationWithLlm(extracted, best.rubric, {
      workExperienceBoost: false,
      deadlineMs,
    });
    top = [refined, ...top.slice(1)];
    top.sort(compareScoredOccupations);
    top = top.slice(0, assessConfig.maxCandidates);
  }

  // After top-N academics: Groq judges confirmed DB jobs vs those occupations.
  if (top.length && useLlm && assessConfig.llmWorkExperience) {
    const judgements = await analyzeWorkExperienceForCandidates(
      caseRow.experienceRows,
      top.map((s) => ({
        anzscoCode: s.rubric.anzscoCode,
        title: s.rubric.title,
      })),
      { useLlm: true, deadlineMs },
    );
    applyWorkExperienceJudgements(top, judgements);
    top.sort(compareScoredOccupations);
  }

  const winner = top[0];
  if (!winner) {
    return emptyNoMatch("No academic ANZSCO rubrics available to assess.");
  }

  const unmatched = winner.unmatched.map((u) => ({
    name: u.name,
    code: u.code ?? null,
    qualification: u.qualification as QualificationType,
  }));
  const matches = dedupeMatchRows(winner.matches);
  const missingSubjects = computeMissingSubjects(matches, winner.rubric);
  const transcriptSource = buildTranscriptSource(
    winner.qualificationsUsed,
    winner.mastersFallbackUsed,
  );
  const candidates = top.map((s) => {
    const m = dedupeMatchRows(s.matches);
    return buildCandidate(
      s.rubric,
      s.scored,
      m,
      computeMissingSubjects(m, s.rubric),
      s.unmatched.map((u) => ({
        name: u.name,
        code: u.code ?? null,
        qualification: u.qualification as QualificationType,
      })),
      {
        workExperienceBoost: s.workExperienceBoost,
        workExperienceAnalysis: s.workExperienceAnalysis,
      },
    );
  });

  const result: AssessmentResult = {
    anzscoCode: winner.scored.anzscoCode,
    title: winner.scored.title,
    recommended: winner.scored.recommended,
    confidence: winner.scored.confidence,
    confidenceScore: winner.scored.confidenceScore,
    determination: winner.scored.determination,
    foundationalMatched: winner.scored.foundationalMatched,
    foundationalExpected: winner.scored.foundationalExpected,
    foundationalPct: winner.scored.foundationalPct,
    coreMatched: winner.scored.coreMatched,
    coreExpected: winner.scored.coreExpected,
    corePct: winner.scored.corePct,
    tier1Outcome: winner.scored.tier1Outcome,
    tier2Outcome: winner.scored.tier2Outcome,
    tier3GateMet: winner.scored.tier3GateMet,
    workExperienceBoost: winner.workExperienceBoost,
    qualificationsUsed: winner.qualificationsUsed,
    matches,
    unmatched,
    missingSubjects,
    transcriptSource,
    mastersFallbackUsed: winner.mastersFallbackUsed,
    candidates,
    extractedSubjects: extracted,
    explanation: "",
  };

  // When nothing is recommended, still surface best coverage numbers from the top card
  if (!result.recommended) {
    result.anzscoCode = null;
    result.title = null;
    result.determination = "no_match";
    result.confidence = null;
  }

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

  if (result.recommended && result.title) {
    await prisma.case.update({
      where: { id: caseId },
      data: { targetOccupation: `${result.title} (${result.anzscoCode})` },
    });
  }

  return result;
}

function scoreOccupation(
  extracted: ExtractedSubjectRow[],
  rubric: Rubric,
  opts: {
    workExperienceBoost: boolean;
  },
): ScoredOccupation {
  const rubricSubjects = flattenRubricSubjects(rubric);

  const bachelorRows = extracted.filter((s) => s.qualification === "bachelor");
  const masterRows = extracted.filter((s) => s.qualification === "master");
  const unknownRows = extracted.filter((s) => s.qualification === "unknown");

  let pool = [...bachelorRows, ...unknownRows];
  let qualificationsUsed: QualificationType[] = pool.length
    ? ([...new Set(pool.map((p) => p.qualification))] as QualificationType[])
    : ["unknown"];

  if (!pool.length) {
    pool = extracted;
    qualificationsUsed = [
      ...new Set(extracted.map((e) => e.qualification)),
    ] as QualificationType[];
  }

  const runMatch = (rows: ExtractedSubjectRow[]) =>
    matchSubjectsSync(rows, rubricSubjects);

  let matchResult = runMatch(pool);
  let scored = scoreAssessment({
    matches: matchResult.matches,
    qualificationsUsed,
    workExperienceBoost: opts.workExperienceBoost,
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
    matchResult = runMatch(pool);
    scored = scoreAssessment({
      matches: matchResult.matches,
      qualificationsUsed,
      workExperienceBoost: opts.workExperienceBoost,
      rubric,
    });
    mastersFallbackUsed = true;
  }

  return {
    rubric,
    scored,
    matches: matchResult.matches,
    unmatched: matchResult.unmatched,
    qualificationsUsed,
    mastersFallbackUsed,
    workExperienceBoost: opts.workExperienceBoost,
    confidenceScoreBefore: scored.confidenceScore,
    workExperienceAnalysis: null,
  };
}

/** Apply Groq judgements: re-score with boost and attach UI analysis. */
function applyWorkExperienceJudgements(
  top: ScoredOccupation[],
  judgements: OccupationWorkJudgement[],
): void {
  const byCode = new Map(
    judgements.map((j) => [j.anzscoCode.replace(/\s+/g, "").toLowerCase(), j]),
  );

  for (const occ of top) {
    const before = occ.confidenceScoreBefore || occ.scored.confidenceScore;
    const judgement = byCode.get(
      occ.rubric.anzscoCode.replace(/\s+/g, "").toLowerCase(),
    );
    const related = Boolean(judgement?.related);

    if (related) {
      occ.workExperienceBoost = true;
      occ.scored = scoreAssessment({
        matches: occ.matches,
        qualificationsUsed: occ.qualificationsUsed,
        workExperienceBoost: true,
        rubric: occ.rubric,
      });
    } else {
      occ.workExperienceBoost = false;
    }

    const after = occ.scored.confidenceScore;
    occ.confidenceScoreBefore = before;
    occ.workExperienceAnalysis = {
      related,
      matchedJobs: related ? judgement?.matchedJobs ?? [] : [],
      analysis: related ? judgement?.analysis ?? "" : "",
      confidenceScoreBefore: before,
      confidenceScoreAfter: after,
    };
  }
}

/** Prefer recommended occupations, then higher numeric confidence, then coverage. */
function compareScoredOccupations(a: ScoredOccupation, b: ScoredOccupation): number {
  if (a.scored.recommended !== b.scored.recommended) {
    return a.scored.recommended ? -1 : 1;
  }
  if (a.scored.confidenceScore !== b.scored.confidenceScore) {
    return b.scored.confidenceScore - a.scored.confidenceScore;
  }
  const detRank = (d: string) =>
    d === "verified_no_risk" ? 0 : d === "conditional" ? 1 : 2;
  const det = detRank(a.scored.determination) - detRank(b.scored.determination);
  if (det !== 0) return det;

  const coverA = a.scored.corePct * 2 + a.scored.foundationalPct;
  const coverB = b.scored.corePct * 2 + b.scored.foundationalPct;
  if (coverB !== coverA) return coverB - coverA;

  if (a.scored.tier3GateMet !== b.scored.tier3GateMet) {
    return a.scored.tier3GateMet ? -1 : 1;
  }
  return a.rubric.title.localeCompare(b.rubric.title);
}

function emptyNoMatch(explanation: string): AssessmentResult {
  const rubrics = loadAllAcademicRubrics();
  const rubric = rubrics[0] ?? loadRubric("chemical-engineer");
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
    confidence: null,
    confidenceScore: 0,
    determination: "no_match",
    recommended: false,
    matches: [],
    missingSubjects,
    unmatched: [],
    subjectCatalog: buildSubjectCatalog(rubric),
  };
  return {
    anzscoCode: null,
    title: null,
    recommended: false,
    confidence: null,
    confidenceScore: 0,
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

function buildSubjectCatalog(rubric: Rubric): AnzscoCandidate["subjectCatalog"] {
  const out: AnzscoCandidate["subjectCatalog"] = [];
  for (const tier of ["tier1", "tier2"] as const) {
    for (const s of rubric.tiers[tier].subjects) {
      if (s.category === "catchAll" || s.name === "Others") continue;
      out.push({
        name: s.name,
        tier,
        category: s.category,
        variants: s.variants ?? [],
      });
    }
  }
  return out;
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
    confidence: ScoreResult["confidence"];
    confidenceScore: number;
    determination: ScoreResult["determination"];
    recommended: boolean;
  },
  matches: SubjectMatch[],
  missingSubjects: MissingSubjectsByTier,
  unmatched: AnzscoCandidate["unmatched"],
  work?: {
    workExperienceBoost?: boolean;
    workExperienceAnalysis?: WorkExperienceCandidateAnalysis | null;
  },
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
    confidence: scored.confidence,
    confidenceScore: scored.confidenceScore,
    determination: scored.determination,
    recommended: scored.recommended,
    workExperienceBoost: work?.workExperienceBoost ?? false,
    workExperienceAnalysis: work?.workExperienceAnalysis ?? null,
    matches,
    missingSubjects,
    unmatched,
    subjectCatalog: buildSubjectCatalog(rubric),
  };
}

/** Pure scoring path for unit tests (no DB / LLM). Scores all academic occupations by default. */
export function assessExtractedSubjects(
  extracted: ExtractedSubjectRow[],
  opts?: { workExperienceBoost?: boolean; occupationId?: string },
): AssessmentResult {
  const rubrics = opts?.occupationId
    ? [loadRubric(opts.occupationId)]
    : loadAllAcademicRubrics();

  const scoredAll = rubrics.map((rubric) =>
    scoreOccupation(extracted, rubric, {
      workExperienceBoost: opts?.workExperienceBoost ?? false,
    }),
  );
  scoredAll.sort(compareScoredOccupations);
  const top = scoredAll.slice(0, assessConfig.maxCandidates);
  const winner = top[0];
  if (!winner) {
    return emptyNoMatch("No academic ANZSCO rubrics available to assess.");
  }

  const deduped = dedupeMatchRows(winner.matches);
  const unmatchedRows = winner.unmatched.map((u) => ({
    name: u.name,
    code: u.code ?? null,
    qualification: u.qualification as QualificationType,
  }));
  const missingSubjects = computeMissingSubjects(deduped, winner.rubric);
  const transcriptSource = buildTranscriptSource(
    winner.qualificationsUsed,
    winner.mastersFallbackUsed,
  );
  const candidates = top.map((s) => {
    const m = dedupeMatchRows(s.matches);
    const boosted = opts?.workExperienceBoost ?? false;
    const before = boosted
      ? Math.max(0, s.scored.confidenceScore - 4)
      : s.scored.confidenceScore;
    const analysis: WorkExperienceCandidateAnalysis | null = boosted
      ? {
          related: true,
          matchedJobs: [],
          analysis: "Work experience boost applied (test path).",
          confidenceScoreBefore: before,
          confidenceScoreAfter: s.scored.confidenceScore,
        }
      : {
          related: false,
          matchedJobs: [],
          analysis: "",
          confidenceScoreBefore: s.scored.confidenceScore,
          confidenceScoreAfter: s.scored.confidenceScore,
        };
    return buildCandidate(
      s.rubric,
      s.scored,
      m,
      computeMissingSubjects(m, s.rubric),
      s.unmatched.map((u) => ({
        name: u.name,
        code: u.code ?? null,
        qualification: u.qualification as QualificationType,
      })),
      {
        workExperienceBoost: boosted,
        workExperienceAnalysis: analysis,
      },
    );
  });

  const result: AssessmentResult = {
    anzscoCode: winner.scored.anzscoCode,
    title: winner.scored.title,
    recommended: winner.scored.recommended,
    confidence: winner.scored.confidence,
    confidenceScore: winner.scored.confidenceScore,
    determination: winner.scored.determination,
    foundationalMatched: winner.scored.foundationalMatched,
    foundationalExpected: winner.scored.foundationalExpected,
    foundationalPct: winner.scored.foundationalPct,
    coreMatched: winner.scored.coreMatched,
    coreExpected: winner.scored.coreExpected,
    corePct: winner.scored.corePct,
    tier1Outcome: winner.scored.tier1Outcome,
    tier2Outcome: winner.scored.tier2Outcome,
    tier3GateMet: winner.scored.tier3GateMet,
    workExperienceBoost: opts?.workExperienceBoost ?? false,
    qualificationsUsed: winner.qualificationsUsed,
    matches: deduped,
    unmatched: unmatchedRows,
    missingSubjects,
    transcriptSource,
    mastersFallbackUsed: winner.mastersFallbackUsed,
    candidates,
    extractedSubjects: extracted,
    explanation: "",
  };

  if (!result.recommended) {
    result.anzscoCode = null;
    result.title = null;
    result.determination = "no_match";
    result.confidence = null;
  }

  result.explanation = buildExplanationFallback(result);
  return result;
}

/** Async refine helper kept for optional LLM match on a single occupation. */
export async function scoreOccupationWithLlm(
  extracted: ExtractedSubjectRow[],
  rubric: Rubric,
  opts: {
    workExperienceBoost: boolean;
    deadlineMs?: number;
  },
): Promise<ScoredOccupation> {
  const rubricSubjects = flattenRubricSubjects(rubric);
  const bachelorRows = extracted.filter((s) => s.qualification === "bachelor");
  const masterRows = extracted.filter((s) => s.qualification === "master");
  const unknownRows = extracted.filter((s) => s.qualification === "unknown");

  let pool = [...bachelorRows, ...unknownRows];
  if (!pool.length) pool = extracted;
  let qualificationsUsed = [
    ...new Set(pool.map((p) => p.qualification)),
  ] as QualificationType[];

  let matchResult = await matchSubjects(pool, rubricSubjects, {
    useLlm: true,
    deadlineMs: opts.deadlineMs,
    occupationTitle: rubric.title,
    anzscoCode: rubric.anzscoCode,
  });
  let scored = scoreAssessment({
    matches: matchResult.matches,
    qualificationsUsed,
    workExperienceBoost: opts.workExperienceBoost,
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
    matchResult = await matchSubjects(pool, rubricSubjects, {
      useLlm: true,
      deadlineMs: opts.deadlineMs,
      occupationTitle: rubric.title,
      anzscoCode: rubric.anzscoCode,
    });
    scored = scoreAssessment({
      matches: matchResult.matches,
      qualificationsUsed,
      workExperienceBoost: opts.workExperienceBoost,
      rubric,
    });
    mastersFallbackUsed = true;
  }

  return {
    rubric,
    scored,
    matches: matchResult.matches,
    unmatched: matchResult.unmatched,
    qualificationsUsed,
    mastersFallbackUsed,
    workExperienceBoost: opts.workExperienceBoost,
    confidenceScoreBefore: scored.confidenceScore,
    workExperienceAnalysis: null,
  };
}
