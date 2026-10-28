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
  hashScoringInput,
  hashSubjectInput,
  type TranscriptSource,
} from "./extractSubjects.js";
import {
  flattenRubricSubjects,
  loadAllAcademicRubrics,
  loadRubric,
  rubricFingerprint,
  scoringSubjects,
  type Rubric,
} from "./loadRubric.js";
import { matchSubjects, matchSubjectsSync } from "./matchSubjects.js";
import type {
  AnzscoCandidate,
  AssessmentResult,
  ExtractedSubjectRow,
  ExtractionReport,
  MissingSubjectsByTier,
  QualificationType,
  SubjectMatch,
  TranscriptSourceInfo,
  WorkExperienceCandidateAnalysis,
} from "./schemas.js";
import {
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

/** Which transcript rows were scored for an occupation. */
type PoolKind = "bachelor" | "master" | "combined";

export type ScoredOccupation = {
  rubric: Rubric;
  scored: ScoreResult;
  matches: SubjectMatch[];
  unmatched: ExtractedSubjectRow[];
  qualificationsUsed: QualificationType[];
  mastersFallbackUsed: boolean;
  poolKind: PoolKind;
  /** Rows of the winning pool (reused by the optional LLM refine). */
  poolRows: ExtractedSubjectRow[];
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
      // Deterministic order: results must not depend on DB row order.
      documents: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      experienceRows: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
      qualifications: { orderBy: [{ degreeLevel: "asc" }, { id: "asc" }] },
      assessment: true,
      extractedSubjects: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
    },
  });
  if (!caseRow) throw new Error("Case not found");

  const transcripts = sortTranscripts(
    caseRow.documents.filter(
      (d) => d.type === "TRANSCRIPT" && d.status === "DONE" && d.text?.trim(),
    ),
  );
  // Latest finished CV wins (a re-upload replaces the older one).
  const cvDoc = [...caseRow.documents]
    .reverse()
    .find((d) => d.type === "CV" && d.status === "DONE");
  const cvText = cvDoc?.text ?? null;
  const persistedRows = caseRow.extractedSubjects.map(rowFromDb);

  if (
    !transcripts.length &&
    !opts?.injectedSubjects?.length &&
    !caseRow.extractedSubjects.length
  ) {
    return emptyNoMatch(
      "No transcript text available to assess. Upload and extract a transcript first.",
    );
  }

  // Two cache levels:
  //  - subjectHash: what subject extraction depends on (transcripts only), so
  //    editing experience / qualifications re-scores without re-extracting.
  //  - inputHash: everything the final score depends on.
  const subjectHash = hashSubjectInput(
    transcripts.map((t) => ({
      id: t.id,
      text: t.text ?? "",
      degreeLevel: t.degreeLevel,
    })),
  );
  const legacyHash = hashAssessmentInput(
    transcripts.map((t) => ({ id: t.id, text: t.text ?? "" })),
    cvText,
  );
  const inputHash = hashScoringInput({
    subjectHash,
    cvText,
    experienceRows: caseRow.experienceRows.map(withoutTimestamps),
    qualifications: caseRow.qualifications.map(withoutTimestamps),
    selectedDegreeLevels: caseRow.selectedDegreeLevels,
    engineeringTitledDegree: caseRow.engineeringTitledDegree,
    rubric: rubricFingerprint(),
    config: scoringConfigFingerprint(),
  });

  const previous = (caseRow.assessment?.resultJson ?? null) as
    | (AssessmentResult & { extraction?: ExtractionReport })
    | null;
  const previousExtraction = previous?.extraction;

  // Cache hit — never for a run whose extraction was incomplete.
  if (
    !opts?.force &&
    !opts?.injectedSubjects &&
    !opts?.occupationId &&
    caseRow.assessment &&
    caseRow.assessment.inputHash === inputHash &&
    previous &&
    previousExtraction?.complete !== false
  ) {
    const cached = previous;
    if (!cached.extractedSubjects?.length && persistedRows.length) {
      cached.extractedSubjects = persistedRows;
    }
    return cached;
  }

  // Persisted subjects are reusable only if they came from the same transcripts
  // and that extraction was complete (legacy rows: old v1 hash must match).
  const canReusePersisted =
    !opts?.force &&
    persistedRows.length > 0 &&
    (previousExtraction
      ? previousExtraction.subjectHash === subjectHash &&
        previousExtraction.complete !== false
      : caseRow.assessment?.inputHash === legacyHash);

  // Step 1 — extract (or reuse persisted / injected)
  let extracted: ExtractedSubjectRow[];
  let extraction: ExtractionReport;
  const warnings: string[] = [];
  if (opts?.injectedSubjects) {
    extracted = opts.injectedSubjects;
    extraction = completeReport(subjectHash, "injected");
  } else if (canReusePersisted) {
    extracted = persistedRows;
    extraction = completeReport(subjectHash, "persisted");
  } else if (useLlm && transcripts.length) {
    const sources: TranscriptSource[] = transcripts.map((t) => ({
      documentId: t.id,
      text: t.text!,
      degreeLevelHint: degreeLevelToQualification(t.degreeLevel),
    }));
    const outcome = await extractSubjectsFromTranscripts(sources, { deadlineMs });
    extraction = {
      subjectHash,
      complete: outcome.complete,
      source: "llm",
      totalParts: outcome.totalParts,
      failedParts: outcome.failedParts,
      skippedParts: outcome.skippedParts,
      missingKeys: outcome.missingKeys,
    };
    if (!outcome.subjects.length && !outcome.complete && persistedRows.length) {
      // Extraction failed outright — keep the previously saved subjects rather
      // than wiping them; the incomplete flag forces a retry next run.
      extracted = persistedRows;
      extraction.source = "persisted";
    } else {
      extracted = outcome.subjects;
      await persistExtractedSubjects(caseId, extracted, transcripts);
    }
  } else if (persistedRows.length) {
    extracted = persistedRows;
    extraction = completeReport(subjectHash, "persisted");
  } else {
    return emptyNoMatch(
      "Could not extract subjects from the transcript (LLM unavailable and no cached subjects).",
    );
  }
  warnings.push(...extractionWarnings(extraction));

  const rubrics = opts?.occupationId
    ? [loadRubric(opts.occupationId)]
    : loadAllAcademicRubrics();

  // Academic sync-match every occupation first (no work experience in ranking).
  const scoredAll = scoreAllOccupations(extracted, rubrics);
  // Wider shortlist first; the final cut to maxCandidates happens only after
  // the work-experience boost so a related job can lift a lower candidate.
  const shortlistSize = Math.max(
    assessConfig.maxCandidates,
    assessConfig.boostShortlist,
  );
  let shortlist = scoredAll.slice(0, shortlistSize);

  // Optional: refine the best occupation with LLM unclear subject matching
  const best = shortlist[0];
  if (best && useLlm && assessConfig.llmUnclearMatches) {
    const refined = await scoreOccupationWithLlm(extracted, best.rubric, {
      workExperienceBoost: false,
      deadlineMs,
      pool: best.poolRows,
    });
    shortlist = [refined, ...shortlist.slice(1)];
    shortlist.sort(compareScoredOccupations);
  }

  // Groq judges confirmed DB jobs vs every shortlisted occupation.
  if (shortlist.length && useLlm && assessConfig.llmWorkExperience) {
    const judgements = await analyzeWorkExperienceForCandidates(
      caseRow.experienceRows,
      shortlist.map((s) => ({
        anzscoCode: s.rubric.anzscoCode,
        title: s.rubric.title,
      })),
      { useLlm: true, deadlineMs },
    );
    shortlist = applyBoostAndCut(shortlist, judgements, shortlist.length);
  }
  const top = shortlist.slice(0, assessConfig.maxCandidates);

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
    winner.poolKind,
    extracted,
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
    warnings,
    extraction,
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

/**
 * Candidate transcript pools for one occupation: Bachelor (+ rows with unknown
 * level), Master's alone, and both combined. The best-scoring pool is kept, so
 * a strong Master's is never ignored just because the Bachelor's looked "ok".
 * Ties prefer Bachelor, then Master's, then combined.
 */
function candidatePools(
  extracted: ExtractedSubjectRow[],
): Array<{ kind: PoolKind; rows: ExtractedSubjectRow[] }> {
  const bachelorish = extracted.filter((s) => s.qualification !== "master");
  const masterRows = extracted.filter((s) => s.qualification === "master");
  const pools: Array<{ kind: PoolKind; rows: ExtractedSubjectRow[] }> = [];
  if (bachelorish.length) pools.push({ kind: "bachelor", rows: bachelorish });
  if (masterRows.length) pools.push({ kind: "master", rows: masterRows });
  if (bachelorish.length && masterRows.length) {
    pools.push({ kind: "combined", rows: [...bachelorish, ...masterRows] });
  }
  if (!pools.length) pools.push({ kind: "bachelor", rows: extracted });
  return pools;
}

function qualificationsOf(rows: ExtractedSubjectRow[]): QualificationType[] {
  return rows.length
    ? ([...new Set(rows.map((p) => p.qualification))] as QualificationType[])
    : ["unknown"];
}

/** Positive when b is better than a (same ordering as candidate ranking). */
function compareScores(a: ScoreResult, b: ScoreResult): number {
  if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
  if (a.confidenceScore !== b.confidenceScore) {
    return b.confidenceScore - a.confidenceScore;
  }
  if (a.coreMatched !== b.coreMatched) return b.coreMatched - a.coreMatched;
  if (a.foundationalMatched !== b.foundationalMatched) {
    return b.foundationalMatched - a.foundationalMatched;
  }
  if (a.tier3GateMet !== b.tier3GateMet) return a.tier3GateMet ? -1 : 1;
  return 0;
}

function gateSubjectOf(rubric: Rubric): string | undefined {
  return rubric.tiers.tier3.gate?.gateSubject;
}

function scoreOccupation(
  extracted: ExtractedSubjectRow[],
  rubric: Rubric,
  opts: {
    workExperienceBoost: boolean;
  },
): ScoredOccupation {
  const rubricSubjects = flattenRubricSubjects(rubric);
  const gateSubject = gateSubjectOf(rubric);

  let best: ScoredOccupation | null = null;
  for (const pool of candidatePools(extracted)) {
    const matchResult = matchSubjectsSync(pool.rows, rubricSubjects, {
      gateSubject,
    });
    const qualificationsUsed = qualificationsOf(pool.rows);
    const scored = scoreAssessment({
      matches: matchResult.matches,
      qualificationsUsed,
      workExperienceBoost: opts.workExperienceBoost,
      rubric,
    });
    // Strictly better only, so earlier pools (Bachelor) win ties.
    if (!best || compareScores(best.scored, scored) > 0) {
      best = {
        rubric,
        scored,
        matches: matchResult.matches,
        unmatched: matchResult.unmatched,
        qualificationsUsed,
        mastersFallbackUsed: pool.kind !== "bachelor",
        poolKind: pool.kind,
        poolRows: pool.rows,
        workExperienceBoost: opts.workExperienceBoost,
        confidenceScoreBefore: scored.confidenceScore,
        workExperienceAnalysis: null,
      };
    }
  }
  return best!;
}

/** Score every rubric (academic only) and return them best-first. */
export function scoreAllOccupations(
  extracted: ExtractedSubjectRow[],
  rubrics: Rubric[] = loadAllAcademicRubrics(),
  opts: { workExperienceBoost: boolean } = { workExperienceBoost: false },
): ScoredOccupation[] {
  const all = rubrics.map((rubric) => scoreOccupation(extracted, rubric, opts));
  all.sort(compareScoredOccupations);
  return all;
}

/**
 * Apply work-experience judgements to the whole shortlist, re-rank, then cut.
 * Cutting after the boost lets a related job lift a lower academic candidate.
 */
export function applyBoostAndCut(
  shortlist: ScoredOccupation[],
  judgements: OccupationWorkJudgement[],
  maxCandidates: number = assessConfig.maxCandidates,
): ScoredOccupation[] {
  const list = [...shortlist];
  applyWorkExperienceJudgements(list, judgements);
  list.sort(compareScoredOccupations);
  return list.slice(0, maxCandidates);
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
  // Equal scores: more absolute core / foundation evidence wins.
  if (a.scored.coreMatched !== b.scored.coreMatched) {
    return b.scored.coreMatched - a.scored.coreMatched;
  }
  if (a.scored.foundationalMatched !== b.scored.foundationalMatched) {
    return b.scored.foundationalMatched - a.scored.foundationalMatched;
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
  // Each row keeps the transcript it came from; fall back to the only
  // transcript when there is exactly one (older rows had no documentId).
  const fallbackDocId = transcripts.length === 1 ? transcripts[0]!.id : null;
  await prisma.extractedSubject.createMany({
    data: rows.map((r, i) => ({
      caseId,
      documentId: r.documentId ?? fallbackDocId,
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
  poolKind: PoolKind,
  extracted: ExtractedSubjectRow[],
): TranscriptSourceInfo {
  const hadBachelor = extracted.some((r) => r.qualification === "bachelor");
  if (poolKind === "master" && hadBachelor) {
    return {
      kind: "master",
      label:
        "Matched using: Master's transcript (scored higher than the Bachelor's on its own)",
    };
  }
  if (poolKind === "combined") {
    return {
      kind: "master_fallback",
      label:
        "Matched using: Bachelor's and Master's subjects combined (scored higher than the Bachelor's on its own)",
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
      if (
        s.category === "catchAll" ||
        s.category === "contextual" ||
        s.name === "Others"
      ) {
        continue;
      }
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
  // Boost (test path) is already applied to every occupation before the cut.
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
    winner.poolKind,
    extracted,
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
    /** Rows to score (default: the best pool chosen by the sync scorer). */
    pool?: ExtractedSubjectRow[];
  },
): Promise<ScoredOccupation> {
  const sync = scoreOccupation(extracted, rubric, {
    workExperienceBoost: opts.workExperienceBoost,
  });
  const pool = opts.pool ?? sync.poolRows;
  const qualificationsUsed = qualificationsOf(pool);
  const matchResult = await matchSubjects(pool, flattenRubricSubjects(rubric), {
    useLlm: true,
    deadlineMs: opts.deadlineMs,
    occupationTitle: rubric.title,
    anzscoCode: rubric.anzscoCode,
    gateSubject: gateSubjectOf(rubric),
  });
  const scored = scoreAssessment({
    matches: matchResult.matches,
    qualificationsUsed,
    workExperienceBoost: opts.workExperienceBoost,
    rubric,
  });
  return {
    ...sync,
    scored,
    matches: matchResult.matches,
    unmatched: matchResult.unmatched,
    qualificationsUsed,
    poolRows: pool,
    confidenceScoreBefore: scored.confidenceScore,
  };
}

// ---------------------------------------------------------------------------
// Helpers: deterministic ordering, cache keys, extraction warnings
// ---------------------------------------------------------------------------

const LEVEL_RANK: Record<string, number> = { bachelor: 0, master: 1 };

/** Bachelor transcripts first, then Master's, then others; stable by upload time / id. */
function sortTranscripts<
  T extends { id: string; degreeLevel: string | null; createdAt: Date },
>(docs: T[]): T[] {
  return [...docs].sort((a, b) => {
    const ra = LEVEL_RANK[a.degreeLevel ?? ""] ?? 2;
    const rb = LEVEL_RANK[b.degreeLevel ?? ""] ?? 2;
    if (ra !== rb) return ra - rb;
    const ta = a.createdAt.getTime();
    const tb = b.createdAt.getTime();
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function rowFromDb(s: {
  name: string;
  code: string | null;
  credits: string | null;
  grade: string | null;
  yearOrSemester: string | null;
  qualification: string;
  sourceSnippet: string | null;
  isRepeat: boolean;
  documentId: string | null;
}): ExtractedSubjectRow {
  return {
    name: s.name,
    code: s.code,
    credits: s.credits,
    grade: s.grade,
    yearOrSemester: s.yearOrSemester,
    qualification: s.qualification as QualificationType,
    sourceSnippet: s.sourceSnippet,
    isRepeat: s.isRepeat,
    documentId: s.documentId,
  };
}

function withoutTimestamps<T extends Record<string, unknown>>(row: T) {
  const { createdAt: _c, updatedAt: _u, ...rest } = row as Record<string, unknown>;
  void _c;
  void _u;
  return rest;
}

/** Config values that change scoring/ranking (timeouts excluded). */
export function scoringConfigFingerprint() {
  return {
    fuzzyThreshold: assessConfig.fuzzyThreshold,
    llmUnclearMatches: assessConfig.llmUnclearMatches,
    llmWorkExperience: assessConfig.llmWorkExperience,
    flagPlusMediumRisk: assessConfig.flagPlusMediumRisk,
    missingTier3Action: assessConfig.missingTier3Action,
    maxCandidates: assessConfig.maxCandidates,
    boostShortlist: assessConfig.boostShortlist,
    coverage: assessConfig.coverage,
    engine: "assess-v2",
  };
}

function completeReport(
  subjectHash: string,
  source: ExtractionReport["source"],
): ExtractionReport {
  return {
    subjectHash,
    complete: true,
    source,
    totalParts: 0,
    failedParts: 0,
    skippedParts: 0,
    missingKeys: false,
  };
}

/** Human-readable warnings for an incomplete extraction (empty when complete). */
export function extractionWarnings(report: ExtractionReport): string[] {
  if (report.complete) return [];
  if (report.missingKeys) {
    return [
      report.source === "persisted"
        ? "Subject extraction is not configured (no Groq API key). Showing previously saved subjects."
        : "Subject extraction is not configured (no Groq API key). No subjects could be read from the transcript.",
    ];
  }
  const bits: string[] = [];
  if (report.failedParts) {
    bits.push(`${report.failedParts} of ${report.totalParts} transcript part(s) failed`);
  }
  if (report.skippedParts) {
    bits.push(`${report.skippedParts} part(s) were skipped (time limit)`);
  }
  const tail =
    report.source === "persisted"
      ? " Showing previously saved subjects."
      : " Some subjects may be missing, so the score may be too low.";
  return [
    `Subject extraction was incomplete: ${bits.join("; ")}.${tail} Re-run the assessment to retry.`,
  ];
}
