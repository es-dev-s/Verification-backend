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
  listVocationalOccupations,
  loadAllAcademicRubrics,
  loadRubric,
  rubricFingerprint,
  scoringSubjects,
  type Rubric,
  type VocationalOccupation,
} from "./loadRubric.js";
import {
  matchOptionsForRubric,
  matchSubjects,
  matchSubjectsSync,
} from "./matchSubjects.js";
import {
  checkQualification,
  type QualificationInfo,
} from "./qualificationCheck.js";
import {
  occupationKind,
  routeOccupation,
  routeQualifications,
  type OccupationRouteDecision,
  type RoutingDecision,
} from "./route.js";
import { isDiplomaLevel } from "./schemas.js";
import type {
  AnzscoCandidate,
  RoutingInfo,
  VocationalAssessmentDetail,
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
  type QualificationCheckResult,
  type ScoreResult,
} from "./score.js";
import { hasUnitCodes, scoreVocational, type VocationalScore } from "./vocational.js";

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
type PoolKind = "bachelor" | "master" | "combined" | "diploma";

export type ScoredOccupation = {
  rubric: Rubric;
  scored: ScoreResult;
  matches: SubjectMatch[];
  unmatched: ExtractedSubjectRow[];
  qualificationsUsed: QualificationType[];
  mastersFallbackUsed: boolean;
  poolKind: PoolKind;
  /** Step 1 qualification check for the winning pool (reused when re-scoring). */
  qualificationCheck: QualificationCheckResult;
  /** Rows of the winning pool (reused by the optional LLM refine). */
  poolRows: ExtractedSubjectRow[];
  workExperienceBoost: boolean;
  /** Academic-only score before work boost (for UI before→after %). */
  confidenceScoreBefore: number;
  workExperienceAnalysis: WorkExperienceCandidateAnalysis | null;
  /** Step 1 routing decision for this occupation (include / cap). */
  routeDecision?: OccupationRouteDecision;
  /** Unit-code detail (vocational occupations only). */
  vocational?: VocationalAssessmentDetail | null;
  /** Re-score a vocational occupation (work-experience boost on / off). */
  rescoreVocational?: (workExperienceBoost: boolean) => VocationalScore;
};

/** Inputs shared by every occupation scored for one case. */
export type ScoringContext = {
  workExperienceBoost: boolean;
  /** Case qualifications (level + title [+ transcript texts]) for routing and Step 1. */
  qualifications?: QualificationInfo[];
  /** Raw transcript texts (unit-code scan for vocational occupations). */
  transcriptTexts?: string[];
  /** Score only this occupation id or ANZSCO; routing never excludes it. */
  occupationId?: string;
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
  // Qualification titles by DB level: refine a document's level (associate
  // degree has no DB enum value) and feed the Step 1 qualification check.
  const titleByLevel = new Map(
    caseRow.qualifications.map((q) => [String(q.degreeLevel), q.degreeTitle ?? null]),
  );
  const docLevel = (t: { degreeLevel: string | null }) =>
    degreeLevelToQualification(
      t.degreeLevel,
      t.degreeLevel ? titleByLevel.get(t.degreeLevel) : null,
    );
  const qualificationInfos: QualificationInfo[] = caseRow.qualifications.map((q) => ({
    level: degreeLevelToQualification(q.degreeLevel, q.degreeTitle),
    title: q.degreeTitle ?? null,
    rawLevel: String(q.degreeLevel),
    // Transcript text at this level, so routing can spot a qualification code.
    texts: transcripts
      .filter(
        (t) =>
          t.degreeLevel === String(q.degreeLevel) ||
          (!t.degreeLevel && caseRow.qualifications.length === 1),
      )
      .map((t) => t.text ?? ""),
  }));
  const transcriptTexts = transcripts.map((t) => t.text ?? "");

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

  // Cache hit
  if (
    !opts?.force &&
    !opts?.injectedSubjects &&
    !opts?.occupationId &&
    caseRow.assessment &&
    caseRow.assessment.inputHash === inputHash &&
    previous
  ) {
    const cached = previous;
    if (!cached.extractedSubjects?.length && persistedRows.length) {
      cached.extractedSubjects = persistedRows;
    }
    return cached;
  }

  // Persisted subjects are reusable only if they came from the same transcripts
  // (legacy rows without an extraction record: old v1 hash must match).
  const canReusePersisted =
    !opts?.force &&
    persistedRows.length > 0 &&
    (previousExtraction
      ? previousExtraction.subjectHash === subjectHash
      : caseRow.assessment?.inputHash === legacyHash);

  // Step 1 — extract (or reuse persisted / injected)
  let extracted: ExtractedSubjectRow[];
  let extraction: ExtractionReport;
  // False when this run produced no usable fresh subjects; the result is then
  // stored without a valid cache key so the next run extracts again.
  let cacheable = true;
  if (opts?.injectedSubjects) {
    extracted = opts.injectedSubjects;
    extraction = { subjectHash, source: "injected" };
  } else if (canReusePersisted) {
    extracted = persistedRows;
    extraction = { subjectHash, source: "persisted" };
  } else if (useLlm && transcripts.length) {
    const sources: TranscriptSource[] = transcripts.map((t) => ({
      documentId: t.id,
      text: t.text!,
      degreeLevelHint: docLevel(t),
    }));
    const fresh = await extractSubjectsFromTranscripts(sources, { deadlineMs });
    const choice = chooseSubjectsAfterExtraction(fresh, persistedRows);
    extracted = choice.rows;
    if (choice.keptSaved) {
      // Extraction returned nothing — keep the saved subjects (not overwritten)
      // and keep their original transcript hash.
      extraction = {
        subjectHash: previousExtraction?.subjectHash ?? "",
        source: "persisted",
      };
      cacheable = false;
    } else {
      extraction = { subjectHash, source: "llm" };
      await persistExtractedSubjects(caseId, extracted, transcripts);
      if (!extracted.length) cacheable = false;
    }
  } else if (persistedRows.length) {
    extracted = persistedRows;
    extraction = { subjectHash, source: "persisted" };
  } else {
    return emptyNoMatch(
      "Could not extract subjects from the transcript (LLM unavailable and no cached subjects).",
    );
  }

  // Saved rows from diploma-level transcripts were stored as "unknown" before
  // diploma levels existed: tag them from their document now.
  extracted = applyDocumentLevels(
    extracted,
    transcripts.map((t) => ({ id: t.id, level: docLevel(t) })),
  );

  // Step 1 routing picks which occupations are ranked; each one is then
  // sync-matched (no work experience in ranking).
  const { scored: scoredAll, routing } = scoreRoutedOccupations(extracted, {
    workExperienceBoost: false,
    qualifications: qualificationInfos,
    transcriptTexts,
    occupationId: opts?.occupationId,
  });
  // Wider shortlist first; the final cut to maxCandidates happens only after
  // the work-experience boost so a related job can lift a lower candidate.
  const shortlistSize = Math.max(
    assessConfig.maxCandidates,
    assessConfig.boostShortlist,
  );
  let shortlist = scoredAll.slice(0, shortlistSize);

  // Optional: refine the best occupation with LLM unclear subject matching
  const best = shortlist[0];
  // Unit-code occupations match on codes only: no LLM refine.
  if (best && !best.vocational && useLlm && assessConfig.llmUnclearMatches) {
    const refined = await scoreOccupationWithLlm(extracted, best.rubric, {
      workExperienceBoost: false,
      deadlineMs,
      pool: best.poolRows,
      qualifications: qualificationInfos,
      routeDecision: best.routeDecision,
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
  const transcriptSource = winner.vocational
    ? VOCATIONAL_SOURCE
    : buildTranscriptSource(winner.qualificationsUsed, winner.poolKind, extracted);
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
      s,
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
    tier1Outcome: winner.vocational ? null : winner.scored.tier1Outcome,
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
    qualificationNotes: winner.scored.qualificationNotes,
    routing: routingInfo(routing),
    assessmentFlow: winner.vocational ? "vocational_units" : "academic",
    bandDetermination: winner.scored.bandDetermination,
    explanation: "",
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
      inputHash: cacheable ? inputHash : "",
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
      inputHash: cacheable ? inputHash : "",
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
 * level), Master's alone, both combined, and diploma-level rows (Diploma /
 * Advanced Diploma / Associate Degree) as their own group. The best-scoring
 * pool is kept, so a strong Master's is never ignored just because the
 * Bachelor's looked "ok". Ties prefer Bachelor, then Master's, then combined,
 * then diploma.
 */
function candidatePools(
  extracted: ExtractedSubjectRow[],
): Array<{ kind: PoolKind; rows: ExtractedSubjectRow[] }> {
  const bachelorish = extracted.filter(
    (s) => s.qualification !== "master" && !isDiplomaLevel(s.qualification),
  );
  const masterRows = extracted.filter((s) => s.qualification === "master");
  const diplomaRows = extracted.filter((s) => isDiplomaLevel(s.qualification));
  const pools: Array<{ kind: PoolKind; rows: ExtractedSubjectRow[] }> = [];
  if (bachelorish.length) pools.push({ kind: "bachelor", rows: bachelorish });
  if (masterRows.length) pools.push({ kind: "master", rows: masterRows });
  if (bachelorish.length && masterRows.length) {
    pools.push({ kind: "combined", rows: [...bachelorish, ...masterRows] });
  }
  if (diplomaRows.length) pools.push({ kind: "diploma", rows: diplomaRows });
  if (!pools.length) pools.push({ kind: "bachelor", rows: extracted });
  return pools;
}

/**
 * Tag rows with their transcript's level when the row has none yet (or only a
 * diploma-family level the document refines, e.g. diploma → associate degree).
 * Bachelor / Master's rows are never changed.
 */
export function applyDocumentLevels(
  rows: ExtractedSubjectRow[],
  documents: Array<{ id: string; level: QualificationType | "unknown" }>,
): ExtractedSubjectRow[] {
  const byId = new Map(documents.map((d) => [d.id, d.level]));
  const only = documents.length === 1 ? documents[0]!.level : null;
  return rows.map((r) => {
    const level = (r.documentId ? byId.get(r.documentId) : null) ?? only;
    if (!level || level === "unknown" || level === r.qualification) return r;
    if (r.qualification !== "unknown" && !isDiplomaLevel(r.qualification)) return r;
    if (r.qualification !== "unknown" && !isDiplomaLevel(level)) return r;
    return { ...r, qualification: level };
  });
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

function scoreOccupation(
  extracted: ExtractedSubjectRow[],
  rubric: Rubric,
  opts: {
    workExperienceBoost: boolean;
    /** Case qualifications (level + title) for the Step 1 check. */
    qualifications?: QualificationInfo[];
    /** Step 1 routing cap for this occupation. */
    routeDecision?: OccupationRouteDecision;
  },
): ScoredOccupation {
  const rubricSubjects = flattenRubricSubjects(rubric);
  const matchOptions = matchOptionsForRubric(rubric);

  let best: ScoredOccupation | null = null;
  for (const pool of candidatePools(extracted)) {
    const matchResult = matchSubjectsSync(pool.rows, rubricSubjects, matchOptions);
    const qualificationsUsed = qualificationsOf(pool.rows);
    const qualificationCheck = withRouteCap(
      checkQualification(rubric, qualificationsUsed, opts.qualifications ?? []),
      opts.routeDecision,
    );
    const scored = scoreAssessment({
      matches: matchResult.matches,
      qualificationsUsed,
      workExperienceBoost: opts.workExperienceBoost,
      rubric,
      qualificationCheck,
    });
    // Strictly better only, so earlier pools (Bachelor) win ties.
    if (!best || compareScores(best.scored, scored) > 0) {
      best = {
        rubric,
        scored,
        matches: matchResult.matches,
        unmatched: matchResult.unmatched,
        qualificationsUsed,
        mastersFallbackUsed: pool.kind === "master" || pool.kind === "combined",
        poolKind: pool.kind,
        qualificationCheck,
        poolRows: pool.rows,
        workExperienceBoost: opts.workExperienceBoost,
        confidenceScoreBefore: scored.confidenceScore,
        workExperienceAnalysis: null,
        routeDecision: opts.routeDecision,
        vocational: null,
      };
    }
  }
  return best!;
}

/** Add the Step 1 route cap to a qualification-check result (no duplicate notes). */
function withRouteCap(
  check: QualificationCheckResult,
  decision?: OccupationRouteDecision,
): QualificationCheckResult {
  if (!decision?.capAtConditional) return check;
  const notes = [...check.notes];
  if (decision.capNote && !notes.includes(decision.capNote)) notes.push(decision.capNote);
  return { capAtConditional: true, notes, routeCapped: true };
}

const VOCATIONAL_SOURCE: TranscriptSourceInfo = {
  kind: "diploma",
  label: "Matched using: unit codes on the transcript",
};

/** Score one vocational (unit-code) occupation as a ScoredOccupation. */
function scoreVocationalOccupation(
  extracted: ExtractedSubjectRow[],
  occupation: VocationalOccupation,
  routing: RoutingDecision,
  ctx: ScoringContext,
  routeDecision: OccupationRouteDecision,
): ScoredOccupation {
  const accepted = routing.qualifications.filter(
    (q) => q.route === "vocational" && q.vocationalOccupationIds.includes(occupation.id),
  );
  const codes = occupation.qualificationCodes.join(" / ");
  const qualificationNote = accepted.length
    ? `Qualification accepted for ${occupation.anzsco}: ${accepted
        .map((q) => q.title ?? q.qualificationCodes.join(", "))
        .join("; ")} (${accepted[0]!.reason}).`
    : `Qualification not confirmed as ${codes || "the required qualification"} or an equivalent ${occupation.title} qualification: assessor to confirm (Step 1).`;
  const rows = extracted;
  const rescore = (boost: boolean) =>
    scoreVocational({
      occupation,
      rows,
      transcriptTexts: ctx.transcriptTexts,
      workExperienceBoost: boost,
      qualificationMet: accepted.length > 0,
      qualificationNote,
      qualificationCheck: withRouteCap({ capAtConditional: false, notes: [] }, routeDecision),
    });
  const v = rescore(ctx.workExperienceBoost);
  const used = v.matches.map((m) => m.qualification);
  const qualificationsUsed = (used.length ? [...new Set(used)] : ["unknown"]) as QualificationType[];
  return {
    rubric: v.rubric,
    scored: v.scored,
    matches: v.matches,
    unmatched: v.unmatched,
    qualificationsUsed,
    mastersFallbackUsed: false,
    poolKind: "diploma",
    qualificationCheck: { capAtConditional: false, notes: v.scored.qualificationNotes },
    poolRows: rows,
    workExperienceBoost: ctx.workExperienceBoost,
    confidenceScoreBefore: v.scored.confidenceScore,
    workExperienceAnalysis: null,
    routeDecision,
    vocational: v.detail,
    rescoreVocational: rescore,
  };
}

/**
 * Step 1 routing + scoring: classify the qualifications, rank only the
 * occupations the route allows (academic and vocational), best-first.
 */
export function scoreRoutedOccupations(
  extracted: ExtractedSubjectRow[],
  ctx: ScoringContext,
): { scored: ScoredOccupation[]; routing: RoutingDecision } {
  const vocational = listVocationalOccupations();
  const routing = routeQualifications(ctx.qualifications ?? [], vocational);
  const transcriptHasUnitCodes = hasUnitCodes(extracted, ctx.transcriptTexts);
  const target = ctx.occupationId?.trim();
  const vocTarget = target
    ? vocational.find((o) => o.id === target || o.anzsco === target)
    : undefined;
  const academic = target ? (vocTarget ? [] : [loadRubric(target)]) : loadAllAcademicRubrics();
  const vocList = target ? (vocTarget ? [vocTarget] : []) : vocational;

  const out: ScoredOccupation[] = [];
  for (const rubric of academic) {
    const decision = routeOccupation(
      routing,
      {
        id: rubric.occupationId ?? rubric.anzscoCode,
        anzsco: rubric.anzscoCode,
        kind: occupationKind(rubric.anzscoCode, "academic"),
      },
      { transcriptHasUnitCodes },
    );
    // A targeted run always scores its occupation (caps still apply).
    if (!decision.include && !target) continue;
    out.push(
      scoreOccupation(extracted, rubric, {
        workExperienceBoost: ctx.workExperienceBoost,
        qualifications: ctx.qualifications,
        routeDecision: decision,
      }),
    );
  }
  for (const occ of vocList) {
    const decision = routeOccupation(
      routing,
      { id: occ.id, anzsco: occ.anzsco, kind: "vocational", scoringEnabled: occ.scoringEnabled },
      { transcriptHasUnitCodes },
    );
    const targetedWithCodes = Boolean(target) && occ.coreUnits.units.some((u) => u.code);
    if (!decision.include && !targetedWithCodes) continue;
    out.push(scoreVocationalOccupation(extracted, occ, routing, ctx, decision));
  }
  out.sort(compareScoredOccupations);
  return { scored: out, routing };
}

/** Saved form of the routing decision (AssessmentResult.routing). */
function routingInfo(routing: RoutingDecision): RoutingInfo {
  return {
    routes: routing.routes,
    label: routing.label,
    basedOn: routing.basedOn,
    note: routing.note,
    notes: routing.notes,
    qualifications: routing.qualifications.map((q) => ({
      title: q.title,
      level: q.level,
      route: q.route,
      reason: q.reason,
    })),
  };
}

/**
 * Score rubrics best-first. Without an explicit rubric list this is the
 * routed run (Step 1 routing, academic + vocational occupations); with a list
 * only those academic rubrics are scored (no routing), as before.
 */
export function scoreAllOccupations(
  extracted: ExtractedSubjectRow[],
  rubrics?: Rubric[],
  opts: { workExperienceBoost: boolean; qualifications?: QualificationInfo[] } = {
    workExperienceBoost: false,
  },
): ScoredOccupation[] {
  if (!rubrics) return scoreRoutedOccupations(extracted, opts).scored;
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

    if (occ.rescoreVocational) {
      occ.workExperienceBoost = related;
      const v = occ.rescoreVocational(related);
      occ.scored = v.scored;
      occ.vocational = v.detail;
    } else if (related) {
      occ.workExperienceBoost = true;
      occ.scored = scoreAssessment({
        matches: occ.matches,
        qualificationsUsed: occ.qualificationsUsed,
        workExperienceBoost: true,
        rubric: occ.rubric,
        qualificationCheck: occ.qualificationCheck,
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

/**
 * Empty-extraction guard: when a fresh extraction returns no subjects but
 * subjects were saved earlier, keep the saved ones instead of wiping them.
 */
export function chooseSubjectsAfterExtraction(
  fresh: ExtractedSubjectRow[],
  saved: ExtractedSubjectRow[],
): { rows: ExtractedSubjectRow[]; keptSaved: boolean } {
  if (!fresh.length && saved.length) return { rows: saved, keptSaved: true };
  return { rows: fresh, keptSaved: false };
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
  if (poolKind === "diploma") {
    return {
      kind: "diploma",
      label: `Matched using: ${diplomaLabel(qualificationsUsed)} transcript`,
    };
  }
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

function diplomaLabel(levels: QualificationType[]): string {
  const names: Record<string, string> = {
    diploma: "Diploma",
    advanced_diploma: "Advanced Diploma",
    associate_degree: "Associate Degree",
  };
  const found = levels.filter((l) => names[l]).map((l) => names[l]!);
  return found.length ? found.join(" / ") : "Diploma-level";
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
    qualificationNotes?: string[];
    qualificationCapped?: boolean;
    tier1Outcome?: ScoreResult["tier1Outcome"];
    tier2Outcome?: ScoreResult["tier2Outcome"];
    bandDetermination?: ScoreResult["bandDetermination"];
    gateDowngraded?: boolean;
    routeCapped?: boolean;
  },
  matches: SubjectMatch[],
  missingSubjects: MissingSubjectsByTier,
  unmatched: AnzscoCandidate["unmatched"],
  work?: {
    workExperienceBoost?: boolean;
    workExperienceAnalysis?: WorkExperienceCandidateAnalysis | null;
  },
  occ?: { vocational?: VocationalAssessmentDetail | null },
): AnzscoCandidate {
  const vocational = occ?.vocational ?? null;
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
    qualificationNotes: scored.qualificationNotes ?? [],
    qualificationCapped: scored.qualificationCapped ?? false,
    assessmentFlow: vocational ? "vocational_units" : "academic",
    tier1Outcome: vocational ? null : scored.tier1Outcome ?? null,
    tier2Outcome: scored.tier2Outcome ?? null,
    bandDetermination: scored.bandDetermination,
    gateDowngraded: scored.gateDowngraded ?? false,
    routeCapped: scored.routeCapped ?? false,
    vocational,
  };
}

/** Pure scoring path for unit tests (no DB / LLM). Scores all academic occupations by default. */
export function assessExtractedSubjects(
  extracted: ExtractedSubjectRow[],
  opts?: {
    workExperienceBoost?: boolean;
    occupationId?: string;
    /** Case qualifications (level + title) for routing and the Step 1 check. */
    qualifications?: QualificationInfo[];
    /** Raw transcript texts (unit-code scan for vocational occupations). */
    transcriptTexts?: string[];
  },
): AssessmentResult {
  // Boost (test path) is already applied to every occupation before the cut.
  const { scored: scoredAll, routing } = scoreRoutedOccupations(extracted, {
    workExperienceBoost: opts?.workExperienceBoost ?? false,
    qualifications: opts?.qualifications,
    transcriptTexts: opts?.transcriptTexts,
    occupationId: opts?.occupationId,
  });
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
  const transcriptSource = winner.vocational
    ? VOCATIONAL_SOURCE
    : buildTranscriptSource(winner.qualificationsUsed, winner.poolKind, extracted);
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
      s,
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
    tier1Outcome: winner.vocational ? null : winner.scored.tier1Outcome,
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
    qualificationNotes: winner.scored.qualificationNotes,
    routing: routingInfo(routing),
    assessmentFlow: winner.vocational ? "vocational_units" : "academic",
    bandDetermination: winner.scored.bandDetermination,
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
    qualifications?: QualificationInfo[];
    routeDecision?: OccupationRouteDecision;
  },
): Promise<ScoredOccupation> {
  const sync = scoreOccupation(extracted, rubric, {
    workExperienceBoost: opts.workExperienceBoost,
    qualifications: opts.qualifications,
    routeDecision: opts.routeDecision,
  });
  const pool = opts.pool ?? sync.poolRows;
  const qualificationsUsed = qualificationsOf(pool);
  const matchResult = await matchSubjects(pool, flattenRubricSubjects(rubric), {
    useLlm: true,
    deadlineMs: opts.deadlineMs,
    occupationTitle: rubric.title,
    anzscoCode: rubric.anzscoCode,
    ...matchOptionsForRubric(rubric),
  });
  const qualificationCheck = withRouteCap(
    checkQualification(rubric, qualificationsUsed, opts.qualifications ?? []),
    opts.routeDecision,
  );
  const scored = scoreAssessment({
    matches: matchResult.matches,
    qualificationsUsed,
    workExperienceBoost: opts.workExperienceBoost,
    rubric,
    qualificationCheck,
  });
  return {
    ...sync,
    scored,
    matches: matchResult.matches,
    unmatched: matchResult.unmatched,
    qualificationsUsed,
    qualificationCheck,
    poolRows: pool,
    confidenceScoreBefore: scored.confidenceScore,
  };
}

// ---------------------------------------------------------------------------
// Helpers: deterministic ordering, cache keys
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
    engine: "assess-v3-routing",
  };
}

