import { prisma } from "../lib/prisma.js";
import { ensureClientNameFromCv } from "../lib/clientName.js";
import { assessConfig } from "./config.js";
import {
  analyzeWorkExperienceForCandidates,
  type OccupationWorkJudgement,
} from "./experienceBoost.js";
import { buildExplanationFallback, writeExplanation } from "./explain.js";
import { hashAssessmentInput, hashScoringInput } from "./extractSubjects.js";
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
import { routeQualifications, type RoutingDecision } from "./route.js";
import { evidenceConfigFingerprint } from "./evidenceConfig.js";
import {
  ENGINEERING_TECHNOLOGIST_CODE,
  familyAdjustmentForResult,
  matchedBackfill,
  matchedSlotsMissing,
  normalizeCode,
  type RankedCandidate,
} from "./familyAdjust.js";
import { evaluateGate1, gateIsOpen, openTracks, TRACK_LABELS, trackForAnzsco } from "./gate1.js";
import { isDiplomaLevel } from "./schemas.js";
import { manualSelectionFrom, NoSavedSubjectsError, type ManualSelection } from "./manualOccupation.js";
import { applyTextPeriods, preferFinalYearGate, withTermIndex } from "./qualificationEvidence.js";
import {
  hasLateralState,
  lateralEntryConfirmed,
  lateralEntryDecided,
  lateralStateOf,
  priorStudyDocumentIds,
  priorStudyMatches,
  priorStudyRowsFor,
  type LateralEntryState,
} from "./lateralEntry.js";
import {
  applyDocumentLevels,
  documentLevelResolver,
  gateOverridesOf,
  lateralEntryForCase,
  qualificationInfosFor,
  readSavedSubjectHash,
  resolveSubjects,
  rowFromDb,
  subjectHashOf,
  usableTranscripts,
} from "./transcriptData.js";

// Moved to transcriptData.ts (Transcript data step); re-exported for callers and tests.
export { applyDocumentLevels, chooseSubjectsAfterExtraction } from "./transcriptData.js";
import type {
  AnzscoCandidate,
  AssessorSelected,
  VocationalAssessmentDetail,
  AssessmentResult,
  ExtractedSubjectRow,
  ExtractionReport,
  FinalProjectEvidence,
  Gate1Decision,
  Gate1Result,
  Gate1TrackId,
  QualificationEvidence,
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
import {
  hasIct60220,
  isTelecomAnzsco,
  scoreTelecomGroup,
  type TelecomSuggestionStatus,
} from "./telecomGroup.js";
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
  /**
   * Assessment-step run: score the saved subjects only, never extract with
   * the LLM (re-reading transcripts is the Transcript data step's job).
   * Throws NoSavedSubjectsError when the case has no saved subjects.
   */
  subjectsOnly?: boolean;
  /** Re-score even when the cached result matches (no re-extraction). */
  rescore?: boolean;
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
  /** Gate 1 track this occupation was scored under. */
  track?: Gate1TrackId;
  /** Priority of that track (1 = assess first); undefined for targeted runs. */
  trackPriority?: number;
  /** Unit-code detail (vocational occupations only). */
  vocational?: VocationalAssessmentDetail | null;
  /** Re-score a vocational occupation (work-experience boost on / off). */
  rescoreVocational?: (workExperienceBoost: boolean) => VocationalScore;
  /** Gate project picked for this occupation (final year preferred). */
  finalProject?: FinalProjectEvidence | null;
  /** Professional Engineer / Technologist tracks never score diploma-level rows. */
  excludeDiplomaRows?: boolean;
  /** Earlier-study rows (lateral entry Route 3) added as Foundational matches. */
  priorStudyRows?: ExtractedSubjectRow[];
  /**
   * Telecommunications group rank. Lower sorts first. Equal values stay
   * joint: nothing after this key (confidence, title) is allowed to split them.
   */
  telecomOrder?: number;
  /** Card label for the telecommunications group (Recommended / Eligible / Rejected / Review). */
  suggestionStatus?: TelecomSuggestionStatus;
  /** Keep the telecommunications score when a work-experience judgement is applied. */
  lockScore?: boolean;
};

/** Inputs shared by every occupation scored for one case. */
export type ScoringContext = {
  workExperienceBoost: boolean;
  /** Case qualifications (level + title [+ transcript texts]) for routing and Step 1. */
  qualifications?: QualificationInfo[];
  /** Raw transcript texts (unit-code scan for vocational occupations). */
  transcriptTexts?: string[];
  /** Score only this occupation id or ANZSCO (tests / dev; bypasses the Gate 1 track filter). */
  occupationId?: string;
  /** Step 2 checkbox: assessor confirmed an engineering-titled degree. */
  engineeringTitledDegree?: boolean | null;
  /** Lateral-entry check decided (Route 2 / 3): Gate 1 skips its bridging / credit flags. */
  lateralEntryDecided?: boolean;
  /** Lateral entry confirmed (Route 3): Gate 1 opens a 2 to under 3-year bachelor. */
  lateralEntryConfirmed?: boolean;
  /** Lateral entry Route 3: earlier-study rows (degree path only, Foundational only). */
  priorStudyRows?: ExtractedSubjectRow[];
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
      // Award level, field of study and Transcript data overrides (gate inputs).
      fieldSources: true,
    },
  });
  if (!caseRow) throw new Error("Case not found");

  // Earlier-study transcripts (lateral entry) are never the bachelor's own subjects.
  const transcripts = usableTranscripts(
    caseRow.documents,
    priorStudyDocumentIds(caseRow.fieldSources),
  );
  const lateralState = lateralStateOf(caseRow.fieldSources);
  // Latest finished CV wins (a re-upload replaces the older one).
  const cvDoc = [...caseRow.documents]
    .reverse()
    .find((d) => d.type === "CV" && d.status === "DONE");
  const cvText = cvDoc?.text ?? null;
  // Clients page name only (no LLM, not part of any hash or the result).
  if (!opts?.injectedSubjects?.length) await ensureClientNameFromCv(caseId);
  // Year / semester filled from the transcript's headings where the read gave none.
  const persistedRows = applyTextPeriods(caseRow.extractedSubjects.map(rowFromDb), transcripts);
  // Qualification titles by DB level: refine a document's level (associate
  // degree has no DB enum value) and feed the Step 1 qualification check.
  const qualificationRows = caseRow.qualifications.map((q) => ({
    degreeLevel: String(q.degreeLevel),
    degreeTitle: q.degreeTitle ?? null,
    country: q.country ?? null,
    institution: q.institution ?? null,
  }));
  const docLevel = documentLevelResolver(qualificationRows);
  // Includes the assessor values from Upload & details / Transcript data /
  // Verify details (award level, field of study, counted duration, share).
  const qualificationInfos: QualificationInfo[] = qualificationInfosFor(
    qualificationRows,
    transcripts,
    caseRow.fieldSources,
  );
  const gateOverrides = gateOverridesOf(qualificationInfos);
  // Assessor-selected occupation (used only when Gate 1 = manual review).
  const manualSelection = manualSelectionFrom(caseRow.fieldSources);
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
  const subjectHash = subjectHashOf(transcripts);
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
    // Only when set, so cases without assessor values keep their cache key.
    ...(gateOverrides ? { gateOverrides } : {}),
    ...(manualSelection ? { manualOccupation: manualSelection.occupationId } : {}),
    // lateralGate: bumped when the Gate 1 lateral-entry rules change, so saved
    // lateral cases re-score once (other cases keep their cache key).
    ...(hasLateralState(lateralState) ? { lateralEntry: lateralHashOf(lateralState), lateralGate: 2 } : {}),
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
    !opts?.rescore &&
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
    const cachedRows = persistedRows.length ? persistedRows : cached.extractedSubjects ?? [];
    const cachedLateral = lateralEntryForCase({
      infos: qualificationInfos,
      rows: cachedRows,
      fieldSources: caseRow.fieldSources,
      documents: caseRow.documents,
    });
    cached.lateralEntry = cachedLateral;
    // Saved results where ET took a top-N slot: fill the matched slot(s) from
    // a deterministic re-score of the saved subjects. The filled card gets the
    // saved work-experience judgement, else a check for that occupation only
    // (AI allowed). Nothing is saved on this read-only load.
    const backfilled = await backfillCachedCandidates(cached, {
      rows: cachedRows,
      lateralEntryDecided: lateralEntryDecided(cachedLateral),
      lateralEntryConfirmed: lateralEntryConfirmed(cachedLateral),
      priorStudyRows: priorStudyRowsFor(cachedLateral, lateralState),
      qualifications: qualificationInfos,
      transcriptTexts,
      engineeringTitledDegree: caseRow.engineeringTitledDegree,
      manualSelection,
      judge:
        useLlm && assessConfig.llmWorkExperience
          ? (occs) =>
              analyzeWorkExperienceForCandidates(
                caseRow.experienceRows,
                occs.map((s) => ({ anzscoCode: s.rubric.anzscoCode, title: s.rubric.title })),
                { useLlm: true, deadlineMs },
              )
          : null,
    });
    // Results saved before the family rules: derive them from the saved candidates.
    if ((backfilled || !cached.familyAdjustment) && cached.candidates?.length) {
      cached.familyAdjustment = familyAdjustmentForResult(cached);
    }
    return cached;
  }

  // Step 1 — subjects: injected (tests), else the Transcript data step's saved
  // subjects when they came from these transcripts, else extract and save
  // (shared with the Transcript data step, see transcriptData.ts).
  let extracted: ExtractedSubjectRow[];
  let extraction: ExtractionReport;
  // False when this run produced no usable fresh subjects; the result is then
  // stored without a valid cache key so the next run extracts again.
  let cacheable = true;
  if (opts?.injectedSubjects) {
    extracted = applyTextPeriods(
      applyDocumentLevels(
        opts.injectedSubjects,
        transcripts.map((t) => ({ id: t.id, level: docLevel(t) })),
      ),
      transcripts,
    ).map(withTermIndex);
    extraction = { subjectHash, source: "injected" };
  } else {
    const resolved = await resolveSubjects({
      caseId,
      transcripts,
      persistedRows,
      subjectHash,
      savedHash: await readSavedSubjectHash(caseId),
      previousExtraction,
      legacyHashMatches: caseRow.assessment?.inputHash === legacyHash,
      docLevel,
      force: opts?.force,
      savedOnly: opts?.subjectsOnly,
      useLlm,
      deadlineMs,
    });
    if (!resolved && opts?.subjectsOnly) throw new NoSavedSubjectsError();
    if (!resolved) {
      return emptyNoMatch(
        "Could not extract subjects from the transcript (LLM unavailable and no cached subjects).",
      );
    }
    extracted = resolved.rows;
    extraction = resolved.extraction;
    cacheable = resolved.cacheable;
  }

  // Lateral entry (before Gate 1): route, answers and the earlier study's subjects.
  const lateral = lateralEntryForCase({
    infos: qualificationInfos,
    rows: extracted,
    fieldSources: caseRow.fieldSources,
    documents: caseRow.documents,
  });
  const priorStudyRows = priorStudyRowsFor(lateral, lateralState);

  // Gate 1 decides which tracks are scored (before any scoring); each
  // occupation in an open track is then sync-matched (no work experience in ranking).
  const { scored: scoredAll, gate, assessorSelected } = scoreWithManualSelection(
    extracted,
    {
      workExperienceBoost: false,
      qualifications: qualificationInfos,
      transcriptTexts,
      occupationId: opts?.occupationId,
      engineeringTitledDegree: caseRow.engineeringTitledDegree,
      lateralEntryDecided: lateralEntryDecided(lateral),
      lateralEntryConfirmed: lateralEntryConfirmed(lateral),
      priorStudyRows,
    },
    manualSelection,
  );
  if (!gateIsOpen(gate) && !opts?.occupationId && !assessorSelected) {
    // Not eligible / manual review: nothing is scored, the reason is the explanation.
    const blocked = gateBlockedResult(gate, extracted, extraction);
    blocked.lateralEntry = lateral;
    await saveAssessment(caseId, blocked, cacheable ? inputHash : "");
    return blocked;
  }
  // Wider shortlist first; the final cut to maxCandidates happens only after
  // the work-experience boost so a related job can lift a lower candidate.
  const shortlistSize = Math.max(
    assessConfig.maxCandidates,
    assessConfig.boostShortlist,
  );
  let shortlist = cutWithTracks(scoredAll, shortlistSize);

  // Optional: refine the best occupation with LLM unclear subject matching
  const best = shortlist[0];
  // Unit-code occupations match on codes only: no LLM refine.
  if (best && !best.vocational && useLlm && assessConfig.llmUnclearMatches) {
    const refined = await scoreOccupationWithLlm(extracted, best.rubric, {
      workExperienceBoost: false,
      deadlineMs,
      pool: best.poolRows,
      qualifications: qualificationInfos,
      excludeDiplomaRows: best.excludeDiplomaRows,
      priorStudyRows: best.priorStudyRows,
    });
    shortlist = [
      { ...refined, track: best.track, trackPriority: best.trackPriority },
      ...shortlist.slice(1),
    ];
    shortlist.sort(compareScoredOccupations);
  }

  // Groq judges confirmed DB jobs vs every shortlisted occupation (up to
  // boostShortlist); all judgements are saved so a cached load can reuse them.
  const judge: WorkJudge | null =
    useLlm && assessConfig.llmWorkExperience
      ? (occs) =>
          analyzeWorkExperienceForCandidates(
            caseRow.experienceRows,
            occs.map((s) => ({ anzscoCode: s.rubric.anzscoCode, title: s.rubric.title })),
            { useLlm: true, deadlineMs },
          )
      : null;
  const workJudgements: OccupationWorkJudgement[] = [];
  if (shortlist.length && judge) {
    const judgements = await judge(shortlist);
    workJudgements.push(...judgements);
    shortlist = applyBoostAndCut(shortlist, judgements, shortlist.length);
  }
  const top = cutWithTracks(shortlist, assessConfig.maxCandidates);

  if (!top[0]) {
    return emptyNoMatch("No academic ANZSCO rubrics available to assess.");
  }
  // ET moved to Maybe Suitable: keep primary + (N − 1) matched alternatives.
  const fills = matchedBackfill(
    top.map(rankedView),
    [...shortlist, ...scoredAll],
    assessConfig.maxCandidates,
    rankedView,
    assessorSelected?.anzscoCode,
  );
  // A backfilled card gets the same work-experience judgement and boost as the
  // shortlist (judged above; one from outside the shortlist is judged now).
  if (judge) {
    workJudgements.push(...(await judgeBackfill(fills, { saved: workJudgements, judge })));
  }
  // Re-rank after the boost; the family rules run on this order afterwards.
  const shown = [...top, ...fills].sort(compareScoredOccupations);
  const winner = shown[0]!;

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
  const candidates = shown.map((s) => {
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
    gate1: gate,
    lateralEntry: lateral,
    assessmentFlow: winner.vocational ? "vocational_units" : "academic",
    bandDetermination: winner.scored.bandDetermination,
    explanation: "",
    extraction,
    qualificationEvidence: buildQualificationEvidence(winner, gate),
    finalProjectTitle: winner.finalProject?.title ?? null,
    ...(assessorSelected ? { assessorSelected } : {}),
    ...(workJudgements.length ? { workExperienceJudgements: workJudgements } : {}),
  };
  result.familyAdjustment = familyAdjustmentForResult(
    result,
    etOwnScore(shortlist, scoredAll),
  );

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

  await saveAssessment(caseId, result, cacheable ? inputHash : "");

  if (result.recommended && result.title) {
    await prisma.case.update({
      where: { id: caseId },
      data: { targetOccupation: `${result.title} (${result.anzscoCode})` },
    });
  }

  return result;
}

/** Upsert the assessment row (same columns as before; Gate 1 lives in resultJson). */
async function saveAssessment(caseId: string, result: AssessmentResult, inputHash: string) {
  const columns = {
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
  };
  await prisma.assessment.upsert({
    where: { caseId },
    create: { caseId, ...columns },
    update: columns,
  });
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
  excludeDiplomaRows = false,
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
  if (diplomaRows.length && !excludeDiplomaRows) pools.push({ kind: "diploma", rows: diplomaRows });
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

function scoreOccupation(
  extracted: ExtractedSubjectRow[],
  rubric: Rubric,
  opts: {
    workExperienceBoost: boolean;
    /** Case qualifications (level + title) for the Step 1 check. */
    qualifications?: QualificationInfo[];
    /** Professional Engineer / Technologist tracks: skip the diploma-level pool. */
    excludeDiplomaRows?: boolean;
    /** Lateral entry Route 3: earlier-study rows (Foundational matches only). */
    priorStudyRows?: ExtractedSubjectRow[];
  },
): ScoredOccupation {
  const rubricSubjects = flattenRubricSubjects(rubric);
  const matchOptions = matchOptionsForRubric(rubric);

  let best: ScoredOccupation | null = null;
  for (const pool of candidatePools(extracted, opts.excludeDiplomaRows)) {
    const matchResult = matchSubjectsSync(pool.rows, rubricSubjects, matchOptions);
    const gate = preferFinalYearGate(matchResult.matches, pool.rows, gateNameOf(rubric));
    matchResult.matches = withPriorStudy(gate.matches, pool.kind, opts.priorStudyRows, rubric);
    const qualificationsUsed = qualificationsOf(pool.rows);
    const qualificationCheck = checkQualification(rubric, qualificationsUsed, opts.qualifications ?? []);
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
        vocational: null,
        finalProject: gate.finalProject,
        excludeDiplomaRows: opts.excludeDiplomaRows,
        ...(opts.priorStudyRows?.length ? { priorStudyRows: opts.priorStudyRows } : {}),
      };
    }
  }
  return best!;
}

/**
 * Lateral entry Route 3: add the earlier study's Foundational matches to a
 * bachelor (or bachelor + master) pool. Primary matches are never replaced.
 */
function withPriorStudy(
  matches: SubjectMatch[],
  kind: PoolKind,
  priorStudyRows: ExtractedSubjectRow[] | undefined,
  rubric: Rubric,
): SubjectMatch[] {
  if (!priorStudyRows?.length || (kind !== "bachelor" && kind !== "combined")) return matches;
  return [
    ...matches,
    ...priorStudyMatches(
      matches,
      priorStudyRows,
      flattenRubricSubjects(rubric),
      matchOptionsForRubric(rubric),
    ),
  ];
}

/** Cache-key part of the lateral-entry state (answers and earlier-study subjects, no timestamps). */
export function lateralHashOf(state: LateralEntryState) {
  return {
    answer: state.answer?.value ?? null,
    confirm: state.confirm?.value ?? null,
    priorSubjects: state.priorSubjects
      ? state.priorSubjects.rows.map((r) => `${r.name}|${r.code ?? ""}|${r.isRepeat ? 1 : 0}`)
      : null,
  };
}

/** Rubric Tier 3 gate subject name (same default as score.ts). */
function gateNameOf(rubric: Rubric): string {
  return (
    rubric.tiers.tier3.gate?.gateSubject ??
    "Major Project / Thesis / Final-Year Project/ Capstone Project"
  );
}

/** Step 3 evidence for the top occupation (engineering decision, final project). Duration is shown by Gate 1. */
export function buildQualificationEvidence(
  winner: ScoredOccupation,
  gate: Gate1Decision,
): QualificationEvidence {
  const engineering = gate.engineering ?? {
    decision: "unclear" as const,
    reason: "no qualification decided Gate 1",
    titleSignal: "none" as const,
    subjectShare: null,
    subjectsConsidered: 0,
    capped: false,
    note: null,
  };
  return {
    duration: [],
    engineering: { ...engineering, capped: false },
    finalProject: winner.finalProject ?? null,
  };
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
      qualificationCheck: { capAtConditional: false, notes: [] },
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
    vocational: v.detail,
    rescoreVocational: rescore,
  };
}

/**
 * Gate 1 + scoring: decide eligibility first, then rank only the occupations
 * in the open tracks (academic and vocational), best-first. A blocked gate
 * (not eligible / manual review) scores nothing. A targeted run (occupationId,
 * tests / dev only) still computes the gate but always scores its occupation.
 */
export function scoreRoutedOccupations(
  extracted: ExtractedSubjectRow[],
  ctx: ScoringContext,
): { scored: ScoredOccupation[]; gate: Gate1Decision } {
  const vocational = listVocationalOccupations();
  const academicAll = loadAllAcademicRubrics();
  const gate = evaluateGate1({
    qualifications: ctx.qualifications ?? [],
    rows: extracted,
    engineeringTitledDegree: ctx.engineeringTitledDegree,
    vocational,
    rubricCodes: academicAll.map((r) => r.anzscoCode),
    lateralEntryDecided: ctx.lateralEntryDecided,
    lateralEntryConfirmed: ctx.lateralEntryConfirmed,
  });
  const routing = routeQualifications(ctx.qualifications ?? [], vocational);
  const out: ScoredOccupation[] = [];

  const target = ctx.occupationId?.trim();
  if (target) {
    if (isTelecomAnzsco(target) && hasIct60220(ctx.qualifications, ctx.transcriptTexts)) {
      const wanted = target === "telecommunications-network-planner" ? "313213" : target.replace(/\s+/g, "");
      const card = scoreTelecomGroup(extracted, ctx.transcriptTexts ?? []).find(
        (c) => c.rubric.anzscoCode === wanted,
      );
      if (card) {
        out.push({ ...telecomOccupation(card, ctx), track: "engineering_associate" });
      }
      return { scored: out, gate };
    }
    const vocTarget = vocational.find((o) => o.id === target || o.anzsco === target);
    if (vocTarget) {
      if (vocTarget.coreUnits.units.some((u) => u.code)) {
        out.push({ ...scoreVocationalOccupation(extracted, vocTarget, routing, ctx), track: "engineering_associate" });
      }
    } else {
      const rubric = loadRubric(target);
      const track = trackForAnzsco(rubric.anzscoCode) ?? undefined;
      out.push({
        ...scoreOccupation(extracted, rubric, {
          workExperienceBoost: ctx.workExperienceBoost,
          qualifications: ctx.qualifications,
          // Earlier-study subjects count on the degree path only.
          priorStudyRows: track !== "engineering_associate" ? ctx.priorStudyRows : undefined,
        }),
        track,
      });
    }
    return { scored: out, gate };
  }

  if (!gateIsOpen(gate)) return { scored: [], gate };

  const priority = new Map(openTracks(gate).map((t) => [t.track, t.priority]));
  for (const rubric of academicAll) {
    const track = trackForAnzsco(rubric.anzscoCode);
    if (!track || !priority.has(track)) continue;
    const excludeDiplomaRows = track !== "engineering_associate";
    out.push({
      ...scoreOccupation(extracted, rubric, {
        workExperienceBoost: ctx.workExperienceBoost,
        qualifications: ctx.qualifications,
        excludeDiplomaRows,
        priorStudyRows: track !== "engineering_associate" ? ctx.priorStudyRows : undefined,
      }),
      track,
      trackPriority: priority.get(track),
    });
  }
  if (priority.has("engineering_associate")) {
    if (hasIct60220(ctx.qualifications, ctx.transcriptTexts)) {
      for (const card of scoreTelecomGroup(extracted, ctx.transcriptTexts ?? [])) {
        out.push({
          ...telecomOccupation(card, ctx),
          track: "engineering_associate",
          trackPriority: priority.get("engineering_associate"),
        });
      }
    }
    const transcriptHasUnitCodes = hasUnitCodes(extracted, ctx.transcriptTexts);
    for (const occ of vocational) {
      if (!occ.scoringEnabled) continue;
      const pointed = routing.vocationalOccupationIds.includes(occ.id);
      if (!pointed && !transcriptHasUnitCodes) continue;
      out.push({
        ...scoreVocationalOccupation(extracted, occ, routing, ctx),
        track: "engineering_associate",
        trackPriority: priority.get("engineering_associate"),
      });
    }
  }
  out.sort(compareScoredOccupations);
  return { scored: out, gate };
}

/**
 * Routed scoring plus the assessor-selected occupation: when Gate 1 asks for
 * manual review and the assessor picked an occupation, that occupation alone
 * is scored (targeted path, gate block bypassed). The gate decision is kept
 * as manual_review; `assessorSelected` marks the result.
 */
export function scoreWithManualSelection(
  extracted: ExtractedSubjectRow[],
  ctx: ScoringContext,
  manual: ManualSelection | null | undefined,
): { scored: ScoredOccupation[]; gate: Gate1Decision; assessorSelected: AssessorSelected | null } {
  const routed = scoreRoutedOccupations(extracted, ctx);
  if (!manual || ctx.occupationId?.trim() || routed.gate.result !== "manual_review") {
    return { ...routed, assessorSelected: null };
  }
  const targeted = scoreRoutedOccupations(extracted, { ...ctx, occupationId: manual.occupationId });
  if (!targeted.scored.length) return { ...routed, assessorSelected: null };
  return {
    scored: targeted.scored,
    gate: routed.gate,
    assessorSelected: { anzscoCode: manual.anzscoCode, title: manual.title, occupationId: manual.occupationId },
  };
}

/** Assessor "check an ANZSCO" result: one occupation scored on the saved subjects, never saved. */
export type OccupationCheck = {
  candidate: AnzscoCandidate;
  track: Gate1TrackId | null;
  trackLabel: string | null;
  /** False when Gate 1 did not open this occupation's track for the case. */
  trackOpen: boolean;
  gateResult: Gate1Result;
};

/**
 * Score one occupation for the assessor's check (pure, deterministic, no AI).
 * Gate 1 never blocks it; the result says whether Gate 1 opened the track.
 * An occupation in an open track is scored exactly like its ranked card;
 * otherwise like the manual-review targeted run. Null when the occupation
 * has no usable rubric.
 */
export function checkOccupation(
  extracted: ExtractedSubjectRow[],
  ctx: Omit<ScoringContext, "occupationId" | "workExperienceBoost">,
  occupationId: string,
): OccupationCheck | null {
  const rows = extracted.map(withTermIndex);
  const full: ScoringContext = { ...ctx, workExperienceBoost: false };
  let routed: { scored: ScoredOccupation[]; gate: Gate1Decision };
  try {
    routed = scoreRoutedOccupations(rows, { ...full, occupationId });
  } catch {
    return null;
  }
  let s = routed.scored[0];
  if (!s) return null;
  const track = s.track ?? null;
  const trackOpen = track !== null && openTracks(routed.gate).some((t) => t.track === track);
  if (!s.vocational && trackOpen && track !== "engineering_associate") {
    s = {
      ...scoreOccupation(rows, s.rubric, {
        workExperienceBoost: false,
        qualifications: ctx.qualifications,
        excludeDiplomaRows: true,
        priorStudyRows: ctx.priorStudyRows,
      }),
      track,
    };
  }
  const matches = dedupeMatchRows(s.matches);
  const candidate = buildCandidate(
    s.rubric,
    s.scored,
    matches,
    computeMissingSubjects(matches, s.rubric),
    s.unmatched.map((u) => ({
      name: u.name,
      code: u.code ?? null,
      qualification: u.qualification as QualificationType,
    })),
    { workExperienceBoost: false, workExperienceAnalysis: null },
    s,
  );
  return {
    candidate,
    track,
    trackLabel: track ? TRACK_LABELS[track] : null,
    trackOpen,
    gateResult: routed.gate.result,
  };
}

/** Read the case rows the occupation check needs (read-only). */
function loadCaseForCheck(caseId: string) {
  return prisma.case.findUnique({
    where: { id: caseId },
    include: {
      documents: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      qualifications: { orderBy: [{ degreeLevel: "asc" }, { id: "asc" }] },
      extractedSubjects: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
      fieldSources: true,
    },
  });
}

export type CheckCaseLoader = typeof loadCaseForCheck;

/**
 * Assessor check of one ANZSCO for a case: the saved subjects (no AI
 * re-extraction), the same Gate 1 / lateral-entry inputs as the assessment,
 * scored for that occupation only. Reads the case and nothing else: the
 * saved assessment, the manual-review selection and the case are untouched.
 */
export async function checkOccupationForCase(
  caseId: string,
  occupationId: string,
  load: CheckCaseLoader = loadCaseForCheck,
): Promise<OccupationCheck | null> {
  const caseRow = await load(caseId);
  if (!caseRow) throw new Error("Case not found");
  const transcripts = usableTranscripts(
    caseRow.documents,
    priorStudyDocumentIds(caseRow.fieldSources),
  );
  const lateralState = lateralStateOf(caseRow.fieldSources);
  const qualificationRows = caseRow.qualifications.map((q) => ({
    degreeLevel: String(q.degreeLevel),
    degreeTitle: q.degreeTitle ?? null,
    country: q.country ?? null,
    institution: q.institution ?? null,
  }));
  const docLevel = documentLevelResolver(qualificationRows);
  const saved = caseRow.extractedSubjects.map(rowFromDb);
  if (!saved.length) throw new NoSavedSubjectsError();
  // Same tagging as a saved-subjects assessment run (document level, printed period).
  const rows = applyTextPeriods(
    applyDocumentLevels(
      saved,
      transcripts.map((t) => ({ id: t.id, level: docLevel(t) })),
    ),
    transcripts,
  ).map(withTermIndex);
  const qualificationInfos = qualificationInfosFor(
    qualificationRows,
    transcripts,
    caseRow.fieldSources,
  );
  const lateral = lateralEntryForCase({
    infos: qualificationInfos,
    rows,
    fieldSources: caseRow.fieldSources,
    documents: caseRow.documents,
  });
  return checkOccupation(
    rows,
    {
      qualifications: qualificationInfos,
      transcriptTexts: transcripts.map((t) => t.text ?? ""),
      engineeringTitledDegree: caseRow.engineeringTitledDegree,
      lateralEntryDecided: lateralEntryDecided(lateral),
      lateralEntryConfirmed: lateralEntryConfirmed(lateral),
      priorStudyRows: priorStudyRowsFor(lateral, lateralState),
    },
    occupationId,
  );
}

/**
 * Cut a ranked list to n, keeping at least one occupation from every track
 * that was scored (the best of a missing track replaces the lowest entry of a
 * track that has more than one), then re-rank.
 */
export function cutWithTracks(list: ScoredOccupation[], n: number): ScoredOccupation[] {
  const top = list.slice(0, n);
  const tracks = [...new Set(list.map((s) => s.track).filter((t): t is Gate1TrackId => !!t))];
  for (const t of tracks) {
    if (top.some((s) => s.track === t)) continue;
    const best = list.find((s) => s.track === t);
    if (!best) continue;
    for (let i = top.length - 1; i >= 0; i--) {
      const tr = top[i]!.track;
      if (top.filter((s) => s.track === tr).length > 1) {
        top[i] = best;
        break;
      }
    }
  }
  return top.sort(compareScoredOccupations);
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
  // Explicit rubric list: scored as given (no Gate 1 filter).
  const all = rubrics.map((rubric) => scoreOccupation(extracted, rubric, opts));
  all.sort(compareScoredOccupations);
  return all;
}

/**
 * Apply work-experience judgements to the whole shortlist, re-rank, then cut.
 * Cutting after the boost lets a related job lift a lower academic candidate.
 */
export type WorkJudge = (occs: ScoredOccupation[]) => Promise<OccupationWorkJudgement[]>;

/**
 * Give backfilled cards the same work-experience judgement (+4 boost when
 * related) as the judged shortlist: reuse a saved judgement for the
 * occupation, else ask `judge` for the occupations still missing one (only
 * those). Mutates `fills`; returns only the new judgements (callers decide
 * whether to save them).
 */
export async function judgeBackfill(
  fills: ScoredOccupation[],
  opts: { saved?: OccupationWorkJudgement[] | null; judge?: WorkJudge | null },
): Promise<OccupationWorkJudgement[]> {
  if (!fills.length) return [];
  const key = (code: string) => code.replace(/\s+/g, "").toLowerCase();
  const savedByCode = new Map((opts.saved ?? []).map((j) => [key(j.anzscoCode), j]));
  // Already judged in this run (shared object from the shortlist).
  const pending = fills.filter((f) => !f.workExperienceAnalysis);
  const missing = pending.filter((f) => !savedByCode.has(key(f.rubric.anzscoCode)));
  let fresh: OccupationWorkJudgement[] = [];
  if (missing.length && opts.judge) {
    try {
      fresh = await opts.judge(missing);
    } catch {
      fresh = [];
    }
  }
  const all = [...savedByCode.values(), ...fresh];
  const judged = new Set(all.map((j) => key(j.anzscoCode)));
  // No judgement available (no AI, no saved one): leave the card as it was.
  const apply = pending.filter((f) => judged.has(key(f.rubric.anzscoCode)));
  if (apply.length) applyWorkExperienceJudgements(apply, all);
  return fresh;
}

export function applyBoostAndCut(
  shortlist: ScoredOccupation[],
  judgements: OccupationWorkJudgement[],
  maxCandidates: number = assessConfig.maxCandidates,
): ScoredOccupation[] {
  const list = [...shortlist];
  applyWorkExperienceJudgements(list, judgements);
  list.sort(compareScoredOccupations);
  return cutWithTracks(list, maxCandidates);
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

    if (occ.lockScore) {
      occ.workExperienceBoost = false;
      occ.confidenceScoreBefore = before;
      occ.workExperienceAnalysis = {
        related,
        matchedJobs: related ? judgement?.matchedJobs ?? [] : [],
        analysis: related ? judgement?.analysis ?? "" : "",
        confidenceScoreBefore: before,
        confidenceScoreAfter: before,
      };
      continue;
    }

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

/** Fields the family rules rank by. */
function rankedView(s: ScoredOccupation): RankedCandidate {
  return {
    anzscoCode: s.rubric.anzscoCode,
    recommended: s.scored.recommended,
    confidenceScore: s.scored.confidenceScore,
  };
}

/**
 * Saved results that stored only the top-N, where ET took one of those slots
 * and moved to Maybe Suitable: append the next-best matched occupation(s)
 * from a deterministic re-score of the saved subjects (nothing saved). Each
 * fill gets the same work-experience judgement and boost as a fresh run: the
 * saved judgement when there is one, else `judge` for that occupation only.
 * Candidates are then re-ranked. Returns true when candidates were added.
 */
export async function backfillCachedCandidates(
  cached: AssessmentResult,
  input: {
    rows: ExtractedSubjectRow[];
    qualifications?: QualificationInfo[];
    transcriptTexts?: string[];
    engineeringTitledDegree?: boolean | null;
    manualSelection?: ManualSelection | null;
    judge?: WorkJudge | null;
    lateralEntryDecided?: boolean;
    lateralEntryConfirmed?: boolean;
    priorStudyRows?: ExtractedSubjectRow[];
  },
): Promise<boolean> {
  const saved = cached.candidates ?? [];
  const n = assessConfig.maxCandidates;
  const assessorCode = cached.assessorSelected?.anzscoCode;
  if (!saved.length || !input.rows.length) return false;
  if (matchedSlotsMissing(saved, n, assessorCode) <= 0) return false;
  try {
    const { scored } = scoreWithManualSelection(
      input.rows.map(withTermIndex),
      {
        workExperienceBoost: false,
        qualifications: input.qualifications,
        transcriptTexts: input.transcriptTexts,
        engineeringTitledDegree: input.engineeringTitledDegree,
        lateralEntryDecided: input.lateralEntryDecided,
        lateralEntryConfirmed: input.lateralEntryConfirmed,
        priorStudyRows: input.priorStudyRows,
      },
      input.manualSelection,
    );
    const ranked = cutWithTracks(
      scored,
      Math.max(n, assessConfig.boostShortlist),
    );
    const fills = matchedBackfill(saved, [...ranked, ...scored], n, rankedView, assessorCode);
    if (!fills.length) return false;
    await judgeBackfill(fills, {
      saved: cached.workExperienceJudgements ?? savedCandidateJudgements(saved),
      judge: input.judge,
    });
    const priority = new Map(
      scored.map((s) => [normalizeCode(s.rubric.anzscoCode), s.trackPriority ?? 99]),
    );
    cached.candidates = rankCandidates(
      [...saved, ...fills.map(candidateFromScored)],
      (code) => priority.get(normalizeCode(code)) ?? 99,
    );
    return true;
  } catch {
    return false;
  }
}

/** Work judgements carried on saved cards (results saved before workExperienceJudgements). */
function savedCandidateJudgements(cands: AnzscoCandidate[]): OccupationWorkJudgement[] {
  return cands
    .filter((c) => c.workExperienceAnalysis)
    .map((c) => ({
      anzscoCode: c.anzscoCode,
      related: Boolean(c.workExperienceAnalysis!.related),
      matchedJobs: c.workExperienceAnalysis!.matchedJobs ?? [],
      analysis: c.workExperienceAnalysis!.analysis ?? "",
    }));
}

/**
 * Re-rank Step 4 cards after a boost, with the same keys as the scoring
 * order (recommended, Gate 1 track priority, confidence, core, foundation).
 * Stable: ties keep their saved order.
 */
export function rankCandidates(
  cands: AnzscoCandidate[],
  priorityOf: (anzscoCode: string) => number = () => 99,
): AnzscoCandidate[] {
  return [...cands].sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    const p = priorityOf(a.anzscoCode) - priorityOf(b.anzscoCode);
    if (p !== 0) return p;
    if (a.confidenceScore !== b.confidenceScore) return b.confidenceScore - a.confidenceScore;
    if (a.coreMatched !== b.coreMatched) return b.coreMatched - a.coreMatched;
    return b.foundationalMatched - a.foundationalMatched;
  });
}

/** Step 4 card for a scored occupation (carries its work judgement when it has one). */
function candidateFromScored(s: ScoredOccupation): AnzscoCandidate {
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
}

/** Engineering Technologist's own matching % when it was scored (first list that has it). */
function etOwnScore(...lists: ScoredOccupation[][]): number | null {
  for (const list of lists) {
    const hit = list.find(
      (s) => normalizeCode(s.rubric.anzscoCode) === ENGINEERING_TECHNOLOGIST_CODE,
    );
    if (hit) return hit.scored.confidenceScore;
  }
  return null;
}

/** Prefer recommended occupations, then Gate 1 track priority, then higher numeric confidence, then coverage. */
function compareScoredOccupations(a: ScoredOccupation, b: ScoredOccupation): number {
  if (a.telecomOrder != null || b.telecomOrder != null) {
    if (a.telecomOrder == null) return 1;
    if (b.telecomOrder == null) return -1;
    if (a.telecomOrder !== b.telecomOrder) return a.telecomOrder - b.telecomOrder;
    return 0;
  }
  if (a.scored.recommended !== b.scored.recommended) {
    return a.scored.recommended ? -1 : 1;
  }
  const pa = a.trackPriority ?? 99;
  const pb = b.trackPriority ?? 99;
  if (pa !== pb) return pa - pb;
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
 * Gate 1 not eligible / manual review: no candidates, no scores, the gate
 * reason is the explanation (no LLM).
 */
export function gateBlockedResult(
  gate: Gate1Decision,
  extracted: ExtractedSubjectRow[],
  extraction?: ExtractionReport,
): AssessmentResult {
  return {
    anzscoCode: null,
    title: null,
    recommended: false,
    confidence: null,
    confidenceScore: 0,
    determination: "no_match",
    foundationalMatched: 0,
    foundationalExpected: 0,
    foundationalPct: 0,
    coreMatched: 0,
    coreExpected: 0,
    corePct: 0,
    tier1Outcome: null,
    tier2Outcome: null,
    tier3GateMet: false,
    workExperienceBoost: false,
    qualificationsUsed: [],
    matches: [],
    unmatched: [],
    missingSubjects: { tier1: [], tier2: [] },
    transcriptSource: {
      kind: "unknown",
      label:
        gate.result === "not_eligible"
          ? "Not scored: Gate 1 result is not eligible"
          : "Not scored: Gate 1 needs manual review",
    },
    mastersFallbackUsed: false,
    candidates: [],
    extractedSubjects: extracted,
    qualificationNotes: [],
    gate1: gate,
    explanation: gate.reason,
    ...(extraction ? { extraction } : {}),
  };
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
  occ?: {
    vocational?: VocationalAssessmentDetail | null;
    finalProject?: FinalProjectEvidence | null;
    track?: Gate1TrackId;
    suggestionStatus?: TelecomSuggestionStatus;
  },
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
    finalProjectTitle: occ?.finalProject?.title ?? null,
    ...(occ?.track ? { track: occ.track } : {}),
    ...(occ?.suggestionStatus ? { suggestionStatus: occ.suggestionStatus } : {}),
  };
}

function telecomOccupation(
  card: ReturnType<typeof scoreTelecomGroup>[number],
  ctx: ScoringContext,
): ScoredOccupation {
  return {
    rubric: card.rubric,
    scored: card.scored,
    matches: card.matches,
    unmatched: card.unmatched,
    qualificationsUsed: ["advanced_diploma"],
    mastersFallbackUsed: false,
    poolKind: "diploma",
    qualificationCheck: { capAtConditional: false, notes: card.scored.qualificationNotes },
    poolRows: [],
    workExperienceBoost: ctx.workExperienceBoost,
    confidenceScoreBefore: card.scored.confidenceScore,
    workExperienceAnalysis: null,
    telecomOrder: card.order,
    suggestionStatus: card.status,
    lockScore: true,
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
    /** Step 2 checkbox: assessor confirmed an engineering-titled degree. */
    engineeringTitledDegree?: boolean | null;
    /** Assessor-selected occupation (used only when Gate 1 = manual review). */
    manualSelection?: ManualSelection | null;
    /** Lateral-entry check decided (Route 2 / 3). */
    lateralEntryDecided?: boolean;
    /** Lateral entry confirmed (Route 3). */
    lateralEntryConfirmed?: boolean;
    /** Lateral entry Route 3: earlier-study rows. */
    priorStudyRows?: ExtractedSubjectRow[];
  },
): AssessmentResult {
  // Work-experience boost (opts, tests) is applied in scoring, before the cut.
  const { scored: scoredAll, gate, assessorSelected } = scoreWithManualSelection(
    extracted.map(withTermIndex),
    {
      workExperienceBoost: opts?.workExperienceBoost ?? false,
      qualifications: opts?.qualifications,
      transcriptTexts: opts?.transcriptTexts,
      occupationId: opts?.occupationId,
      engineeringTitledDegree: opts?.engineeringTitledDegree,
      lateralEntryDecided: opts?.lateralEntryDecided,
      lateralEntryConfirmed: opts?.lateralEntryConfirmed,
      priorStudyRows: opts?.priorStudyRows,
    },
    opts?.manualSelection,
  );
  if (!gateIsOpen(gate) && !opts?.occupationId && !assessorSelected) {
    return gateBlockedResult(gate, extracted);
  }
  const top = cutWithTracks(scoredAll, assessConfig.maxCandidates);
  const winner = top[0];
  if (!winner) {
    return emptyNoMatch("No academic ANZSCO rubrics available to assess.");
  }
  // ET moved to Maybe Suitable: keep primary + (N − 1) matched alternatives.
  const shown = [
    ...top,
    ...matchedBackfill(
      top.map(rankedView),
      scoredAll,
      assessConfig.maxCandidates,
      rankedView,
      assessorSelected?.anzscoCode,
    ),
  ];

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
  // Test / injected path: the boost (when asked) is already in the scores;
  // no work judgement is made here.
  const candidates = shown.map(candidateFromScored);

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
    gate1: gate,
    assessmentFlow: winner.vocational ? "vocational_units" : "academic",
    bandDetermination: winner.scored.bandDetermination,
    explanation: "",
    qualificationEvidence: buildQualificationEvidence(winner, gate),
    finalProjectTitle: winner.finalProject?.title ?? null,
    ...(assessorSelected ? { assessorSelected } : {}),
  };
  result.familyAdjustment = familyAdjustmentForResult(result, etOwnScore(scoredAll));

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
    excludeDiplomaRows?: boolean;
    priorStudyRows?: ExtractedSubjectRow[];
  },
): Promise<ScoredOccupation> {
  const sync = scoreOccupation(extracted, rubric, {
    workExperienceBoost: opts.workExperienceBoost,
    qualifications: opts.qualifications,
    excludeDiplomaRows: opts.excludeDiplomaRows,
    priorStudyRows: opts.priorStudyRows,
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
  const gate = preferFinalYearGate(matchResult.matches, pool, gateNameOf(rubric));
  gate.matches = withPriorStudy(gate.matches, sync.poolKind, opts.priorStudyRows, rubric);
  const qualificationCheck = checkQualification(rubric, qualificationsUsed, opts.qualifications ?? []);
  const scored = scoreAssessment({
    matches: gate.matches,
    qualificationsUsed,
    workExperienceBoost: opts.workExperienceBoost,
    rubric,
    qualificationCheck,
  });
  return {
    ...sync,
    scored,
    finalProject: gate.finalProject,
    matches: gate.matches,
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
    evidence: evidenceConfigFingerprint(),
    engine: "assess-v5-gate1",
  };
}

