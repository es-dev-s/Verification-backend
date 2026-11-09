import { degreeLevelFromTitle } from "./extractSubjects.js";
import type { VocationalOccupation } from "./loadRubric.js";
import { hasTopicWord } from "./matchSubjects.js";
import { isDiplomaLevel, type QualificationType } from "./schemas.js";

/**
 * Qualification classification (used by Gate 1 and the Associate track).
 *
 * Each qualification on the case is classified:
 * - vocational: a training-package qualification code (UEE62122, RII60520 …)
 *   or a Diploma / Advanced Diploma / Associate Degree whose title matches a
 *   vocational occupation's accepted titles → that unit-code occupation.
 * - draftsperson_academic: Diploma / Adv Dip / Associate Degree / Bachelor of
 *   Engineering Technology in Mechanical Drafting/Design.
 * - professional: Bachelor's / Master's (or doctorate) in engineering.
 * - unknown: no title, or a title that fits none of the above.
 *
 * Which occupation tracks are scored is decided by Gate 1 (gate1.ts), not here.
 */

export type QualificationRoute =
  | "vocational"
  | "draftsperson_academic"
  | "professional"
  | "unknown";

/** Which family an occupation belongs to, for routing. */
export type OccupationKind = "professional" | "mech_draftsperson" | "vocational";

export const MECH_DRAFTSPERSON_ANZSCO = "312511";

/** Words that make a title a drafting / design / CAD title. */
export const DRAFTING_WORDS = ["draft*", "draught*", "design*", "cad", "autocad"] as const;
const MECHANICAL_WORDS = ["mechanical", "mech"] as const;
const ENGINEERING_WORDS = ["engineer*", "engg", "beng", "meng", "btech", "mtech", "be", "me"] as const;

/** Training-package qualification code, e.g. UEE62122, RII60520, ICT60220. */
const QUALIFICATION_CODE_RE = /\b[A-Z]{3}\d{5}\b/g;

export type RouteQualificationInput = {
  /** Level mapped for scoring (see degreeLevelToQualification). */
  level: QualificationType | "unknown";
  /** DB degree level as stored (e.g. "phd"), when known. */
  rawLevel?: string | null;
  title: string | null;
  /** Transcript texts at this qualification's level, to spot a qualification code. */
  texts?: readonly string[];
};

export type RoutedQualification = {
  title: string | null;
  level: QualificationType | "unknown";
  route: QualificationRoute;
  /** Vocational occupation ids this qualification points at. */
  vocationalOccupationIds: string[];
  /** Qualification codes found (title or transcript). */
  qualificationCodes: string[];
  /** True when this qualification also lets 312511 be ranked. */
  allowsMechDraftsperson: boolean;
  /** Short plain-language reason for the route. */
  reason: string;
};

export type RoutingDecision = {
  /** Distinct routes of the identified qualifications (["unknown"] when none). */
  routes: QualificationRoute[];
  qualifications: RoutedQualification[];
  /** Short route label, e.g. "professional engineer". */
  label: string;
  /** Qualification title(s) the route is based on ("" when none). */
  basedOn: string;
  /** Extra assessor notes (ignored untitled qualifications, vocational scoring off …). */
  notes: string[];
  /** Vocational occupation ids the qualifications point at (enabled or not). */
  vocationalOccupationIds: string[];
};

export const ROUTE_LABELS: Record<QualificationRoute, string> = {
  professional: "professional engineer",
  draftsperson_academic: "mechanical drafting (academic)",
  vocational: "vocational (unit codes)",
  unknown: "qualification not identified",
};

/** Normalized qualification codes found in a piece of text. */
export function findQualificationCodes(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const m of text.toUpperCase().matchAll(QUALIFICATION_CODE_RE)) found.add(m[0]);
  return [...found];
}

export function isEngineeringTitle(title: string): boolean {
  if (hasTopicWord(title, ENGINEERING_WORDS)) return true;
  if (/\b[bm]\.\s?(?:e|eng|tech)\b\.?/i.test(title)) return true;
  // "Bachelor of Technology" (B.Tech) is an engineering degree; IT degrees are not.
  return /\b(?:bachelor|master)'?s?\s+of\s+technology\b/i.test(title);
}

function isEngineeringTechnologyBachelor(title: string): boolean {
  return /\bengineering\s+technolog/i.test(title) || /\bb\.?\s?eng\.?\s?tech\b/i.test(title);
}

function titleMatches(title: string, allOf: readonly (readonly string[])[]): boolean {
  return allOf.length > 0 && allOf.every((group) => hasTopicWord(title, group));
}

/** Classify one qualification. */
export function classifyQualification(
  q: RouteQualificationInput,
  vocational: readonly VocationalOccupation[],
): RoutedQualification {
  const title = q.title?.trim() || null;
  const level: QualificationType | "unknown" =
    q.level && q.level !== "unknown" ? q.level : (degreeLevelFromTitle(title) ?? "unknown");
  const codes = [
    ...new Set([
      ...findQualificationCodes(title),
      ...(q.texts ?? []).flatMap((t) => findQualificationCodes(t)),
    ]),
  ];
  const mechDraft =
    title != null &&
    hasTopicWord(title, MECHANICAL_WORDS) &&
    hasTopicWord(title, DRAFTING_WORDS);
  const base = { title, level, qualificationCodes: codes };

  // 1. Training-package code that names a vocational occupation's qualification.
  const byCode = vocational.filter((o) => o.qualificationCodes.some((c) => codes.includes(c)));
  if (byCode.length) {
    const matched = codes.filter((c) => byCode.some((o) => o.qualificationCodes.includes(c)));
    return {
      ...base,
      route: "vocational",
      vocationalOccupationIds: byCode.map((o) => o.id),
      allowsMechDraftsperson: mechDraft,
      reason: `qualification code ${matched.join(", ")}`,
    };
  }

  if (!title) {
    return {
      ...base,
      route: "unknown",
      vocationalOccupationIds: [],
      allowsMechDraftsperson: false,
      reason: "no qualification title on file",
    };
  }

  const diplomaFamily = isDiplomaLevel(level);

  // 2. Diploma-family title that matches a vocational occupation's accepted titles.
  if (diplomaFamily) {
    const byTitle = vocational.filter((o) => titleMatches(title, o.titleMatch));
    if (byTitle.length) {
      return {
        ...base,
        route: "vocational",
        vocationalOccupationIds: byTitle.map((o) => o.id),
        allowsMechDraftsperson: mechDraft,
        reason: "diploma-level title matches a vocational qualification",
      };
    }
  }

  // 3. Mechanical drafting / design at diploma level or BEngTech → 312511.
  if (mechDraft && (diplomaFamily || isEngineeringTechnologyBachelor(title))) {
    return {
      ...base,
      route: "draftsperson_academic",
      vocationalOccupationIds: [],
      allowsMechDraftsperson: true,
      reason: "mechanical drafting / design qualification",
    };
  }

  // 4. Bachelor's / Master's / doctorate in engineering.
  const degree = level === "bachelor" || level === "master" || q.rawLevel === "phd";
  if (degree && isEngineeringTitle(title)) {
    return {
      ...base,
      route: "professional",
      vocationalOccupationIds: [],
      allowsMechDraftsperson: hasTopicWord(title, DRAFTING_WORDS),
      reason: "engineering degree",
    };
  }

  return {
    ...base,
    route: "unknown",
    vocationalOccupationIds: [],
    allowsMechDraftsperson: false,
    reason:
      level === "unknown"
        ? "qualification level not identified"
        : "title does not match an engineering route",
  };
}

/** Classify every qualification and summarise them (labels, vocational ids, notes). */
export function routeQualifications(
  qualifications: readonly RouteQualificationInput[],
  vocational: readonly VocationalOccupation[],
): RoutingDecision {
  const routed = qualifications.map((q) => classifyQualification(q, vocational));
  const known = routed.filter((r) => r.route !== "unknown");
  const notes: string[] = [];

  if (!known.length) {
    return {
      routes: ["unknown"],
      qualifications: routed,
      label: "qualification not identified",
      basedOn: "",
      notes,
      vocationalOccupationIds: [],
    };
  }

  const ignored = routed.filter((r) => r.route === "unknown");
  for (const r of ignored) {
    notes.push(
      r.title
        ? `Qualification "${r.title}" not used for routing (${r.reason}).`
        : "A qualification with no title on file was not used for routing.",
    );
  }

  const order: QualificationRoute[] = ["professional", "draftsperson_academic", "vocational"];
  const routes = order.filter((r) => known.some((k) => k.route === r));
  const vocationalOccupationIds = [...new Set(known.flatMap((k) => k.vocationalOccupationIds))];
  for (const id of vocationalOccupationIds) {
    const occ = vocational.find((o) => o.id === id);
    if (occ && !occ.scoringEnabled) {
      notes.push(
        `${occ.title} (${occ.anzsco}): unit-code scoring is not switched on yet (${occ.disabledReason ?? "rubric incomplete"}); assess this occupation manually.`,
      );
    }
  }

  const basedOn = [...new Set(known.map((k) => k.title ?? k.qualificationCodes.join(", ")))]
    .filter(Boolean)
    .join("; ");
  const label = routes.map((r) => ROUTE_LABELS[r]).join(" + ");
  return {
    routes,
    qualifications: routed,
    label,
    basedOn,
    notes,
    vocationalOccupationIds,
  };
}

/** Routing family of an occupation from its ANZSCO code and flow. */
export function occupationKind(anzsco: string, flow: "academic" | "vocational"): OccupationKind {
  if (flow === "vocational") return "vocational";
  return anzsco === MECH_DRAFTSPERSON_ANZSCO ? "mech_draftsperson" : "professional";
}
