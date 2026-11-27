/**
 * Assessment routing after scoring (suggested workflow, 2026):
 *  1. Configurable confidence floor (default 50%): no auto-recommend below it.
 *     The routing record keeps the top scores and the factors that lowered them.
 *  2. Continue with this ANZSCO after a check: lock that occupation, score it,
 *     label User-selected; below the floor is allowed with a manual-review flag.
 *  3. Continue on a closed track → manual intervention (no automated risk).
 *     A track is closed when Gate 1 did not open it, or track-status.json marks it closed.
 *  4. Specialisation ANZSCOs (specialisation-anzsco.json) require a Master's in
 *     an accepted field, else manual intervention.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assessConfig } from "./config.js";
import { identifyDegreeField } from "./degreeField.js";
import { TRACK_LABELS, trackForAnzsco } from "./gate1.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import type {
  AssessmentResult,
  Gate1Decision,
  Gate1Result,
  MastersOnFile,
  WorkflowRouting,
  WorkflowRoutingCode,
  WorkflowRoutingKind,
  WorkflowTopScore,
} from "./schemas.js";

export type { WorkflowRouting, WorkflowRoutingCode, WorkflowRoutingKind };

type SpecialisationDef = {
  anzscoCode: string;
  label: string;
  parentAnzsco: string;
  parentLabel: string;
  acceptedFields: string[];
  fieldLabel: string;
};

type SpecialisationFile = { occupations: SpecialisationDef[] };

type TrackStatus = Record<string, "open" | "closed">;

const here = dirname(fileURLToPath(import.meta.url));

let specialisations: SpecialisationDef[] | null = null;
function loadSpecialisations(): SpecialisationDef[] {
  if (!specialisations) {
    const path = resolve(here, "../lib/specialisation-anzsco.json");
    specialisations = (JSON.parse(readFileSync(path, "utf8")) as SpecialisationFile).occupations;
  }
  return specialisations;
}

const defaultTrackStatusPath = resolve(here, "../lib/track-status.json");

/** Read on every call so an edit to track-status.json applies without a restart. */
export function loadTrackStatus(filePath: string = defaultTrackStatusPath): TrackStatus {
  return JSON.parse(readFileSync(filePath, "utf8")) as TrackStatus;
}

export function specialisationOf(code: string | null | undefined): SpecialisationDef | null {
  const n = digits(code);
  return loadSpecialisations().find((s) => s.anzscoCode === n) ?? null;
}

export function isSpecialisationAnzsco(code: string | null | undefined): boolean {
  return specialisationOf(code) != null;
}

/** True when the maintained track list marks this occupation's track closed. */
export function trackListCloses(anzscoCode: string, status: TrackStatus = loadTrackStatus()): boolean {
  const track = trackForAnzsco(anzscoCode);
  return track != null && status[track] === "closed";
}

export function isMasterQualification(q: QualificationInfo): boolean {
  const raw = (q.rawLevel || q.level || "").toLowerCase();
  if (raw === "master") return true;
  return /\b(m\.?\s*sc|m\.?\s*eng|master'?s?|master of)\b/i.test(q.title ?? "");
}

function digits(code: string | null | undefined): string {
  return String(code ?? "").replace(/\D+/g, "");
}

function haystackOf(q: QualificationInfo): string {
  return [(q.title ?? "").trim(), (q.fieldOfStudy ?? "").trim()].filter(Boolean).join(" ");
}

function titleHasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

export function mastersOnFile(qualifications: readonly QualificationInfo[]): MastersOnFile[] {
  return qualifications.filter(isMasterQualification).map((q) => ({
    title: (q.title ?? "").trim() || null,
    field: (q.fieldOfStudy ?? "").trim() || identifyDegreeField(haystackOf(q))?.label || null,
    institution: (q.institution ?? "").trim() || null,
  }));
}

function fieldWasRead(q: QualificationInfo): boolean {
  if ((q.fieldOfStudy ?? "").trim()) return true;
  const title = (q.title ?? "").trim();
  if (!title) return false;
  return identifyDegreeField(title) != null;
}

function matchesAccepted(q: QualificationInfo, spec: SpecialisationDef): boolean {
  const text = haystackOf(q);
  if (!text) return false;
  return spec.acceptedFields.some((k) => titleHasWord(text, k));
}

export type MastersCheck = {
  ok: boolean;
  message: string;
  masters: MastersOnFile[];
};

const MASTERS_REASON = "Specialization ANZSCO without a Master's in the same field";

export function specialisationMastersCheck(
  anzscoCode: string,
  qualifications: readonly QualificationInfo[],
): MastersCheck {
  const spec = specialisationOf(anzscoCode);
  if (!spec) return { ok: true, message: "", masters: [] };

  const masters = qualifications.filter(isMasterQualification);
  const found = mastersOnFile(qualifications);
  if (!masters.length) {
    return {
      ok: false,
      masters: [],
      message: `${MASTERS_REASON}. No Master's was found. ${spec.label} (${spec.anzscoCode}) needs a Master's in ${spec.fieldLabel}.`,
    };
  }
  if (masters.some((q) => matchesAccepted(q, spec))) {
    return { ok: true, message: "", masters: found };
  }
  const listed = found
    .map((m) => [m.title, m.field, m.institution].filter(Boolean).join(", "))
    .filter(Boolean);
  const detail = listed.length ? ` Master's on file: ${listed.join("; ")}.` : "";
  if (masters.every((q) => !fieldWasRead(q))) {
    return {
      ok: false,
      masters: found,
      message: `${MASTERS_REASON}. Field of study could not be read.${detail}`,
    };
  }
  return {
    ok: false,
    masters: found,
    message: `${MASTERS_REASON}. The Master's field does not match ${spec.fieldLabel}.${detail}`,
  };
}

export function highestConfidenceOf(result: Pick<AssessmentResult, "confidenceScore" | "candidates">): number {
  const scores = [
    result.confidenceScore ?? 0,
    ...(result.candidates ?? []).map((c) => c.confidenceScore ?? 0),
  ];
  return scores.reduce((m, n) => (n > m ? n : m), 0);
}

export function topScoresOf(result: Pick<AssessmentResult, "confidenceScore" | "anzscoCode" | "title" | "candidates">): WorkflowTopScore[] {
  const rows: WorkflowTopScore[] = (result.candidates ?? []).map((c) => ({
    anzscoCode: c.anzscoCode,
    title: c.title,
    confidenceScore: Math.round(c.confidenceScore ?? 0),
  }));
  if (!rows.length && result.anzscoCode) {
    rows.push({
      anzscoCode: result.anzscoCode,
      title: result.title ?? result.anzscoCode,
      confidenceScore: Math.round(result.confidenceScore ?? 0),
    });
  }
  return rows.sort((a, b) => b.confidenceScore - a.confidenceScore);
}

/** Why the scores stayed under the floor, from data already on the assessment. */
export function loweringFactors(result: AssessmentResult): string[] {
  const factors: string[] = [];
  if (result.extraction?.partial) factors.push("Subjects not read");
  const weak = (result.candidates ?? []).some((c) => {
    const unmatched = c.unmatched?.length ?? 0;
    const coreLow = (c.coreExpected ?? 0) > 0 && (c.corePct ?? 0) < 50;
    const foundLow = (c.foundationalExpected ?? 0) > 0 && (c.foundationalPct ?? 0) < 50;
    return unmatched >= 3 || coreLow || foundLow;
  });
  if (weak) factors.push("Weak subject matching");
  const used = result.gate1?.qualifications?.find((q) => q.used);
  if (used && (used.durationSource === "none" || used.durationYears == null)) {
    factors.push("Missing duration");
  }
  return factors;
}

function workingAnzsco(result: AssessmentResult): string | null {
  return (
    result.assessorSelected?.anzscoCode ??
    result.candidates?.find((c) => c.recommended)?.anzscoCode ??
    result.anzscoCode ??
    null
  );
}

function clearAutomatedRecommendation(result: AssessmentResult): void {
  result.recommended = false;
  result.anzscoCode = null;
  result.title = null;
  result.determination = "no_match";
  result.confidence = null;
  for (const c of result.candidates ?? []) {
    c.recommended = false;
  }
}

function routing(
  kind: WorkflowRoutingKind,
  code: WorkflowRoutingCode | null,
  message: string,
  allowRisk: boolean,
  highest: number,
  extra: Partial<Pick<WorkflowRouting, "topScores" | "factors" | "masters" | "closedTrack">> = {},
): WorkflowRouting {
  return {
    kind,
    code,
    message,
    minConfidence: assessConfig.minConfidence,
    highestConfidence: highest,
    allowRisk,
    ...extra,
  };
}

function closedTrackRouting(anzscoCode: string, highest: number): WorkflowRouting {
  const track = trackForAnzsco(anzscoCode);
  const trackLabel = track ? TRACK_LABELS[track] : null;
  const where = trackLabel ? `${trackLabel} track` : "a closed track";
  return routing(
    "manual_intervention",
    "closed_track",
    `Chosen ANZSCO is in a closed track. ${anzscoCode} is on the ${where}. Automated risk will not run.`,
    false,
    highest,
    { closedTrack: { anzscoCode, track, trackLabel } },
  );
}

/**
 * Closed-track Continue: the maintained list marks the track closed, Gate 1
 * is not eligible, or Gate 1 is open but this occupation's track was not.
 */
export function isClosedTrackContinue(opts: {
  anzscoCode: string;
  gateResult: Gate1Result | undefined;
  trackOpen: boolean;
  /** False when Gate 1 has no track rows (legacy / stub) — do not assume closed. */
  hasTrackInfo?: boolean;
}): boolean {
  if (trackListCloses(opts.anzscoCode)) return true;
  if (opts.gateResult === "manual_review") return false;
  if (opts.gateResult === "not_eligible") return true;
  if (opts.gateResult !== "open") return false;
  if (opts.hasTrackInfo === false) return false;
  return !opts.trackOpen;
}

/** Preview for the Check-an-ANZSCO card (read-only). */
export function previewContinueRouting(opts: {
  anzscoCode: string;
  confidenceScore: number;
  trackOpen: boolean;
  gateResult: Gate1Result;
  qualifications?: readonly QualificationInfo[];
  /** False when Gate 1 has no track rows — do not assume the occupation's track is closed. */
  hasTrackInfo?: boolean;
}): WorkflowRouting {
  const min = assessConfig.minConfidence;
  const highest = opts.confidenceScore;
  if (
    isClosedTrackContinue({
      anzscoCode: opts.anzscoCode,
      gateResult: opts.gateResult,
      trackOpen: opts.trackOpen,
      hasTrackInfo: opts.hasTrackInfo,
    })
  ) {
    return closedTrackRouting(opts.anzscoCode, highest);
  }
  if (isSpecialisationAnzsco(opts.anzscoCode)) {
    const spec = specialisationMastersCheck(opts.anzscoCode, opts.qualifications ?? []);
    if (!spec.ok) {
      return routing("manual_intervention", "specialisation_masters", spec.message, false, highest, {
        masters: spec.masters,
      });
    }
  }
  if (highest < min) {
    return routing(
      "manual_review",
      "below_min_confidence",
      `No ANZSCO reached ${min}%. Confidence is ${Math.round(highest)}%. Continuing labels it User-selected and sends the case to manual review; risk can still run.`,
      true,
      highest,
    );
  }
  return routing("ok", null, "", true, highest);
}

/**
 * Continue / risk routing for one selected ANZSCO. Ignores whatever routing
 * was saved for the recommended occupation.
 */
export function routingForSelectedOccupation(opts: {
  anzscoCode: string;
  confidenceScore: number;
  gate: Pick<Gate1Decision, "result" | "tracks"> | undefined;
  qualifications?: readonly QualificationInfo[];
}): WorkflowRouting {
  const tracks = opts.gate?.tracks ?? [];
  const track = trackForAnzsco(opts.anzscoCode);
  const trackOpen = track != null && tracks.some((t) => t.open && t.track === track);
  return previewContinueRouting({
    anzscoCode: opts.anzscoCode,
    confidenceScore: opts.confidenceScore,
    trackOpen,
    gateResult: opts.gate?.result ?? "open",
    qualifications: opts.qualifications,
    hasTrackInfo: tracks.length > 0,
  });
}

/**
 * Post-process a scored assessment. Mutates and returns `result`.
 */
export function applyWorkflowRouting(
  result: AssessmentResult,
  opts: {
    qualifications?: readonly QualificationInfo[];
    userSelected?: boolean;
  } = {},
): AssessmentResult {
  const min = assessConfig.minConfidence;
  const highest = highestConfidenceOf(result);
  const userSelected = Boolean(opts.userSelected || result.assessorSelected?.source === "user");
  const code = workingAnzsco(result);
  const quals = opts.qualifications ?? [];
  const scores = topScoresOf(result);
  const factors = loweringFactors(result);

  if (userSelected && code && result.gate1) {
    const tracks = result.gate1.tracks ?? [];
    const track = trackForAnzsco(code);
    const opened = tracks.some((t) => t.open && t.track === track);
    if (
      isClosedTrackContinue({
        anzscoCode: code,
        gateResult: result.gate1.result,
        trackOpen: opened,
        hasTrackInfo: tracks.length > 0,
      })
    ) {
      clearAutomatedRecommendation(result);
      result.workflowRouting = closedTrackRouting(code, highest);
      return result;
    }
  }

  if (code && isSpecialisationAnzsco(code)) {
    const spec = specialisationMastersCheck(code, quals);
    if (!spec.ok) {
      clearAutomatedRecommendation(result);
      result.workflowRouting = routing("manual_intervention", "specialisation_masters", spec.message, false, highest, {
        masters: spec.masters,
      });
      return result;
    }
  }

  if (highest < min) {
    clearAutomatedRecommendation(result);
    const floor = {
      topScores: scores,
      ...(factors.length ? { factors } : {}),
    };
    if (userSelected || result.assessorSelected) {
      result.workflowRouting = routing(
        "manual_review",
        "below_min_confidence",
        `No ANZSCO reached ${min}%. The chosen occupation is ${Math.round(highest)}%. The case is flagged for manual review; risk can still run.`,
        true,
        highest,
        floor,
      );
      return result;
    }
    result.workflowRouting = routing(
      "manual_review",
      "below_min_confidence",
      `No ANZSCO reached ${min}%. No automated recommendation; send to manual review.`,
      false,
      highest,
      floor,
    );
    return result;
  }

  result.workflowRouting = routing("ok", null, "", true, highest);
  return result;
}
