/**
 * Assessment routing after scoring (suggested workflow, 2026):
 *  1. Configurable confidence floor (default 50%): no auto-recommend below it.
 *  2. Continue with this ANZSCO after a check: lock that occupation, score it,
 *     label User-selected; below the floor is allowed with a manual-review flag.
 *  3. Continue on a closed Gate 1 track → manual intervention (no automated risk).
 *  4. Structural 233214 / Transport 233215 / Geotechnical 233212 require a
 *     Master's in a matching field, else manual intervention.
 */
import { assessConfig } from "./config.js";
import { identifyDegreeField } from "./degreeField.js";
import { openTracks, TRACK_LABELS, trackForAnzsco } from "./gate1.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import type {
  AssessmentResult,
  Gate1Result,
  WorkflowRouting,
  WorkflowRoutingCode,
  WorkflowRoutingKind,
} from "./schemas.js";

export type { WorkflowRouting, WorkflowRoutingCode, WorkflowRoutingKind };

export const SPECIALISATION_ANZSCO = {
  "233214": {
    label: "Structural Engineer",
    keywords: ["structural", "civil"],
  },
  "233215": {
    label: "Transport Engineer",
    keywords: ["transport", "transportation", "civil"],
  },
  "233212": {
    label: "Geotechnical Engineer",
    keywords: ["geotechnical", "soil", "civil"],
  },
} as const;

export type SpecialisationAnzsco = keyof typeof SPECIALISATION_ANZSCO;

export function isSpecialisationAnzsco(code: string | null | undefined): code is SpecialisationAnzsco {
  const n = digits(code);
  return n === "233214" || n === "233215" || n === "233212";
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

export function specialisationMastersCheck(
  anzscoCode: string,
  qualifications: readonly QualificationInfo[],
): { ok: boolean; message: string } {
  const n = digits(anzscoCode);
  const spec = SPECIALISATION_ANZSCO[n as SpecialisationAnzsco];
  if (!spec) return { ok: true, message: "" };

  const masters = qualifications.filter(isMasterQualification);
  if (!masters.length) {
    return {
      ok: false,
      message: `${spec.label} (${n}) needs a Master's in a matching field (or manual intervention). No Master's was found.`,
    };
  }

  const matching = masters.filter((q) => {
    const text = haystackOf(q);
    if (!text) return false;
    if (spec.keywords.some((k) => titleHasWord(text, k))) return true;
    const field = identifyDegreeField(text);
    if (!field) return false;
    if (n === "233214") return field.id === "structural" || field.id === "civil";
    if (n === "233215") return field.id === "civil";
    if (n === "233212") return field.id === "geotechnical" || field.id === "civil";
    return false;
  });

  if (!matching.length) {
    return {
      ok: false,
      message: `${spec.label} (${n}) needs a Master's in a matching field (or manual intervention). The Master's on file does not match that field.`,
    };
  }
  return { ok: true, message: "" };
}

function titleHasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

export function highestConfidenceOf(result: Pick<AssessmentResult, "confidenceScore" | "candidates">): number {
  const scores = [
    result.confidenceScore ?? 0,
    ...(result.candidates ?? []).map((c) => c.confidenceScore ?? 0),
  ];
  return scores.reduce((m, n) => (n > m ? n : m), 0);
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
): WorkflowRouting {
  return {
    kind,
    code,
    message,
    minConfidence: assessConfig.minConfidence,
    highestConfidence: highest,
    allowRisk,
  };
}

/**
 * Closed-track Continue: Gate 1 is open (or not eligible) but this occupation's
 * track was not opened for the case.
 */
export function isClosedTrackContinue(opts: {
  anzscoCode: string;
  gateResult: Gate1Result | undefined;
  trackOpen: boolean;
  /** False when Gate 1 has no track rows (legacy / stub) — do not assume closed. */
  hasTrackInfo?: boolean;
}): boolean {
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
}): WorkflowRouting {
  const min = assessConfig.minConfidence;
  const highest = opts.confidenceScore;
  if (isClosedTrackContinue({ anzscoCode: opts.anzscoCode, gateResult: opts.gateResult, trackOpen: opts.trackOpen })) {
    const track = trackForAnzsco(opts.anzscoCode);
    const label = track ? TRACK_LABELS[track] : "this";
    return routing(
      "manual_intervention",
      "closed_track",
      `Continue on a closed Gate 1 track (${label}) needs manual intervention. Automated risk will not run.`,
      false,
      highest,
    );
  }
  if (isSpecialisationAnzsco(opts.anzscoCode)) {
    const spec = specialisationMastersCheck(opts.anzscoCode, opts.qualifications ?? []);
    if (!spec.ok) {
      return routing("manual_intervention", "specialisation_masters", spec.message, false, highest);
    }
  }
  if (highest < min) {
    return routing(
      "manual_review",
      "below_min_confidence",
      `Confidence is ${Math.round(highest)}% (below the ${min}% floor). Continuing labels it User-selected and sends the case to manual review; risk can still run.`,
      true,
      highest,
    );
  }
  return routing("ok", null, "", true, highest);
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

  if (userSelected && code && result.gate1) {
    const track = trackForAnzsco(code);
    const opened = openTracks(result.gate1).some((t) => t.track === track);
    if (
      isClosedTrackContinue({
        anzscoCode: code,
        gateResult: result.gate1.result,
        trackOpen: opened,
        hasTrackInfo: (result.gate1.tracks?.length ?? 0) > 0,
      })
    ) {
      clearAutomatedRecommendation(result);
      const label = track ? TRACK_LABELS[track] : "this";
      result.workflowRouting = routing(
        "manual_intervention",
        "closed_track",
        `Continue on a closed Gate 1 track (${label}) needs manual intervention. Automated risk will not run.`,
        false,
        highest,
      );
      return result;
    }
  }

  if (code && isSpecialisationAnzsco(code)) {
    const spec = specialisationMastersCheck(code, quals);
    if (!spec.ok) {
      clearAutomatedRecommendation(result);
      result.workflowRouting = routing("manual_intervention", "specialisation_masters", spec.message, false, highest);
      return result;
    }
  }

  if (highest < min) {
    clearAutomatedRecommendation(result);
    if (userSelected || result.assessorSelected) {
      result.workflowRouting = routing(
        "manual_review",
        "below_min_confidence",
        `User-selected occupation is ${Math.round(highest)}% (below the ${min}% floor). The case is flagged for manual review; risk can still run.`,
        true,
        highest,
      );
      return result;
    }
    result.workflowRouting = routing(
      "manual_review",
      "below_min_confidence",
      `Highest ANZSCO confidence is ${Math.round(highest)}% (below the ${min}% floor). No automated recommendation; send to manual review.`,
      false,
      highest,
    );
    return result;
  }

  result.workflowRouting = routing("ok", null, "", true, highest);
  return result;
}
