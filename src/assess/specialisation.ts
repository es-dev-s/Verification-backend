/**
 * Civil Engineer specialisation check (Structural 233214, Geotechnical 233212,
 * Transport 233215) following "Specialization Application Flow
 * (Structural_Geotech_Transport)" (doc 12):
 *
 *  1. Bachelor's transcript must cover the general Civil Engineering core
 *     (§2.2 / §3.1). If any core area is missing the specialisation pathways
 *     are not evaluated ("does not proceed further") and the outcome is High Risk.
 *  2. Specialisation base subjects on the Bachelor's (§3.2–3.4 "Bachelor's").
 *  3. Two independent pathways, either one is enough (§1, §2.3):
 *       A — Master's title + subject list vs the specialisation taxonomy → relevance %.
 *       B — FTE years of specialisation work (≥ 5) + CV duties vs competency list → relevance %.
 *     The stronger, better-supported pathway is used.
 *  4. Risk (§2.4 / §4): weighted score (pathway relevance + evidence quality)
 *     and the §4 table signals; the worse of them gives No / Slight / High Risk.
 *  5. Audit trail (§2.5): matched / unmatched subjects and duties with confidence,
 *     and the routing note for the assessor.
 *
 * Pure and deterministic (no LLM, no DB): runs on data already on the case
 * (extracted transcript rows, qualification titles, experience rows, CV text).
 */
import type { ExtractedSubjectRow } from "./schemas.js";

export const SPECIALISATION_VERSION = "2026-11-03-doc12";

export type SpecialisationTier = "no_risk" | "slight_risk" | "high_risk";

export type TaxonomyHit = { item: string; evidence: string; confidence: number };

export type CoverageResult = {
  matched: TaxonomyHit[];
  missing: string[];
  coveragePct: number;
};

export type PathwayAResult = {
  available: boolean;
  degreeTitle: string | null;
  titleFit: "specific" | "generic" | "unrelated" | "none";
  subjectsCounted: number;
  matched: TaxonomyHit[];
  unmatched: string[];
  coursePct: number | null;
  relevancePct: number;
  satisfied: boolean;
  tier: SpecialisationTier;
  notes: string[];
};

export type PathwayBRole = {
  title: string;
  start: string | null;
  end: string | null;
  months: number;
  fte: number;
  specialistTitle: boolean;
  competencies: string[];
  relevance: number;
  counted: boolean;
};

export type PathwayBResult = {
  available: boolean;
  fteYears: number;
  totalYears: number;
  relevancePct: number;
  competencyPct: number;
  roles: PathwayBRole[];
  competenciesMatched: TaxonomyHit[];
  competenciesMissing: string[];
  referenceLetters: "not_in_system";
  timelineConsistent: boolean;
  satisfied: boolean;
  tier: SpecialisationTier;
  notes: string[];
};

export type SpecialisationOutcome = {
  anzscoCode: string;
  title: string;
  base: CoverageResult & { level: "full" | "partial" | "little" };
  pathwayA: PathwayAResult;
  pathwayB: PathwayBResult;
  /** Pathway used for the outcome (null when the Civil core is not met). */
  chosen: "A" | "B" | null;
  academicTier: SpecialisationTier;
  /** 0–100: 70% pathway relevance + 30% evidence quality. */
  score: number;
  tier: SpecialisationTier;
  gaps: string[];
  routing: string;
};

export type SpecialisationAuditEntry = { step: string; detail: string };

export type SpecialisationResult = {
  version: string;
  computedAt: string;
  civilCore: CoverageResult & { met: boolean };
  specialisations: SpecialisationOutcome[];
  audit: SpecialisationAuditEntry[];
};

/* ------------------------------------------------------------------ */
/* Taxonomy (doc 12 §3) — synonym dictionary per subject area / duty. */
/* ------------------------------------------------------------------ */

type Term = { item: string; re: RegExp };

/** §3.1 general Civil Engineering core (all must be present). */
export const CIVIL_CORE: Term[] = [
  { item: "Structural Analysis", re: /structur\w*\s+analy|theory of structures?|analysis of structures|structural mechanics/i },
  {
    item: "Structural Design (Concrete/Steel)",
    re: /(reinforced|prestressed|r\.?c\.?c?\.?)\s+concrete|concrete (design|structures?)|steel (design|structures?)|design of (r\.?c|reinforced|steel|concrete|structures?)|structural design|rcc design/i,
  },
  { item: "Geotechnical / Soil Mechanics", re: /soil mechanics|geotechn|foundation engineering|geomechanics/i },
  { item: "Fluid Mechanics / Hydraulics", re: /fluid mechanics|hydraulic|fluid dynamics|hydrology/i },
  { item: "Surveying", re: /survey|geomatics|geodesy/i },
  {
    item: "Construction Materials",
    re: /(construction|building|civil engineering|engineering) materials|materials? (of|for) construction|concrete technology|material science|materials science/i,
  },
  {
    item: "Construction / Project Management",
    re: /construction (management|planning|engineering|technology|methods|practice)|project management|estimat|quantity survey|engineering management|professional practice/i,
  },
  { item: "Transportation / Highway Engineering", re: /transport|highway|traffic|road engineering|pavement|railway/i },
  { item: "Engineering Mathematics", re: /math|calculus|linear algebra|differential equations|numerical methods|statistic|probability/i },
  {
    item: "Engineering Mechanics / Statics",
    re: /engineering mechanics|applied mechanics|statics|mechanics of (solids|materials)|strength of materials|solid mechanics|structural mechanics/i,
  },
];

type SpecDef = {
  anzscoCode: string;
  title: string;
  base: Term[];
  /** Master's coursework keywords (base subjects plus advanced topics). */
  masterCourse: RegExp;
  masterTitle: RegExp;
  roleTitle: RegExp;
  competencies: Term[];
};

export const SPECIALISATIONS: SpecDef[] = [
  {
    anzscoCode: "233214",
    title: "Structural Engineer",
    base: [
      { item: "Structural Analysis I & II", re: /structur\w*\s+analy|theory of structures?|analysis of structures/i },
      { item: "Reinforced Concrete Design", re: /reinforced concrete|r\.?c\.?c?\.? design|concrete (design|structures?)|design of (r\.?c|reinforced|concrete)/i },
      { item: "Steel Structure Design", re: /steel (design|structures?)|design of steel/i },
      { item: "Structural Dynamics", re: /structural dynamics|dynamics of structures|structural vibration/i },
      { item: "Earthquake / Seismic Engineering", re: /earthquake|seismic/i },
      { item: "Finite Element Methods", re: /finite element/i },
      { item: "Timber / Masonry Structures", re: /timber|masonry/i },
      { item: "Bridge Engineering", re: /bridge/i },
      { item: "Prestressed Concrete", re: /pre-?stress/i },
    ],
    masterCourse: /structur|concrete|steel|seismic|earthquake|bridge|finite element|stability|plates?|shells?|composite|wind engineering|masonry|timber|pre-?stress/i,
    masterTitle: /structur|earthquake|seismic/i,
    roleTitle: /structural\s+(engineer|design|designer|analyst)|structures?\s+engineer|bridge\s+engineer/i,
    competencies: [
      { item: "Structural analysis and modelling", re: /\betabs\b|sap\s?2000|staad|\brisa\b|structural (analysis|model)|\btekla\b|\bcsi\b/i },
      { item: "Design of structural elements", re: /\b(beams?|columns?|slabs?|footings?|connections?)\b/i },
      { item: "Load calculations", re: /dead load|live load|wind load|seismic load|load calculation|loading calc|gravity load/i },
      { item: "Structural drawings and detailing", re: /structural drawings?|detailing|shop drawings?/i },
      { item: "Code compliance", re: /as\/?nzs\s?1170|\bas\s?3600|\bas\s?4100|aci\s?318|eurocode|\bis\s?456|\bis\s?800|bs\s?8110|code compliance|building code/i },
      { item: "Structural certification or sign-off", re: /certif|sign-?off|design approval|peer review/i },
    ],
  },
  {
    anzscoCode: "233212",
    title: "Geotechnical Engineer",
    base: [
      { item: "Soil Mechanics I & II", re: /soil mechanics|geomechanics/i },
      { item: "Foundation Engineering", re: /foundation/i },
      { item: "Geotechnical Design", re: /geotechnical (design|engineering)/i },
      { item: "Rock Mechanics", re: /rock mechanics|rock engineering/i },
      { item: "Slope Stability", re: /slope/i },
      { item: "Ground Improvement Techniques", re: /ground improvement|soil (improvement|stabili[sz]ation)/i },
      { item: "Retaining Structures", re: /retaining|earth pressure/i },
      { item: "Geotechnical Site Investigation", re: /site investigation|subsurface (exploration|investigation)|geotechnical investigation|soil exploration/i },
      { item: "Engineering Geology", re: /geology/i },
    ],
    masterCourse: /soil|geotech|foundation|rock|slope|ground|retaining|geolog|tunnel|earth|pile|geosynthetic|geo-?environmental/i,
    masterTitle: /geotech|soil|foundation|geomechan|ground engineering/i,
    roleTitle: /geo-?technical|ground\s+engineer|soil\s+engineer|foundation\s+engineer/i,
    competencies: [
      { item: "Soil investigation and borehole logging", re: /borehole|soil investigation|site investigation|test pits?|bore log|logging/i },
      { item: "Laboratory test interpretation", re: /\bspt\b|\bcbr\b|triaxial|consolidation|atterberg|proctor|laboratory test/i },
      { item: "Foundation design", re: /foundation design|\bpiles?\b|piled|shallow foundation|deep foundation|\braft\b/i },
      { item: "Slope stability analysis", re: /slope stability|slope\/w|plaxis|geostudio/i },
      { item: "Retaining wall design", re: /retaining wall|sheet pil|soil nail|ground anchor/i },
      { item: "Geotechnical reporting and ground improvement", re: /geotechnical report|ground improvement|grouting|stone column/i },
    ],
  },
  {
    anzscoCode: "233215",
    title: "Transport Engineer",
    base: [
      { item: "Highway / Road Engineering", re: /highway|road (engineering|design)/i },
      { item: "Traffic Engineering", re: /traffic engineering|traffic management/i },
      { item: "Transportation Planning", re: /transport\w* planning/i },
      { item: "Pavement Design", re: /pavement/i },
      { item: "Traffic Flow Theory", re: /traffic flow/i },
      { item: "Public Transport Systems", re: /public transport|mass transit|transit systems?/i },
      { item: "Road Safety Engineering", re: /road safety|traffic safety/i },
      { item: "Airport / Rail Engineering", re: /airport|rail/i },
      { item: "Traffic Signal Design / ITS", re: /signal|intelligent transport/i },
      { item: "Geometric Design of Roads", re: /geometric design/i },
    ],
    masterCourse: /transport|traffic|highway|pavement|road|rail|transit|airport|signal|mobility|geometric design|logistics/i,
    masterTitle: /transport|traffic|highway|pavement|road/i,
    roleTitle: /transport\w*\s+(engineer|planner)|traffic\s+engineer|highway\s+engineer|road\s+(design\s+)?engineer|pavement\s+engineer/i,
    competencies: [
      { item: "Traffic modelling and impact assessment", re: /\bsidra\b|vissim|aimsun|traffic model|traffic impact|synchro|paramics/i },
      { item: "Pavement design", re: /pavement/i },
      { item: "Geometric road design", re: /geometric design|road design|horizontal alignment|vertical alignment|\b12d\b|civil\s?3d|openroads/i },
      { item: "Traffic signal design", re: /traffic signal|signal design|\bscats\b|intersection design/i },
      { item: "Road safety audits", re: /road safety audit|safety audit|crash analysis/i },
      { item: "Public transport and network planning", re: /public transport|network planning|transport planning|transit planning/i },
    ],
  },
];

/* --------------------------- thresholds --------------------------- */
// Doc 12 gives the rules in words; the numbers below are this system's reading.
/** Base subjects: "covers all" (lists are "such as") → full at ≥ 70%. */
export const BASE_FULL_PCT = 70;
/** "little to no coverage" below this. */
export const BASE_LITTLE_PCT = 25;
/** Master's coursework "predominantly" specialisation-specific. */
export const MASTER_PREDOMINANT_PCT = 50;
/** "only part of its coursework" lower bound. */
export const MASTER_PART_PCT = 25;
/** Pathway B: five years of directly relevant (FTE) experience. */
export const PATHWAY_B_YEARS = 5;
/** A role counts towards Pathway B years at this relevance or above. */
export const ROLE_COUNTED_RELEVANCE = 0.5;
/** Weighted score bands (placeholders, same spirit as the risk 85/75/50 bands). */
export const SCORE_NO_RISK = 75;
export const SCORE_SLIGHT_RISK = 50;

/* ------------------------------ helpers --------------------------- */

const TIER_RANK: Record<SpecialisationTier, number> = { no_risk: 0, slight_risk: 1, high_risk: 2 };
const worse = (...t: SpecialisationTier[]) =>
  t.reduce((a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a), "no_risk" as SpecialisationTier);
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

function coverage(terms: Term[], subjects: string[]): CoverageResult {
  const matched: TaxonomyHit[] = [];
  const missing: string[] = [];
  for (const t of terms) {
    const hit = subjects.find((s) => t.re.test(s));
    if (hit) {
      // Exact area name → 1.0; synonym / keyword → 0.8.
      const exact = hit.toLowerCase().includes(t.item.split(/[ /(]/)[0]!.toLowerCase());
      matched.push({ item: t.item, evidence: hit, confidence: exact ? 1 : 0.8 });
    } else missing.push(t.item);
  }
  return { matched, missing, coveragePct: pct(matched.length, terms.length) };
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/** Month index (year*12+month) from "Jan 2020", "01/2020", "2020-01", "2020" or "Present". */
export function monthIndex(raw: string | null | undefined, now: Date, end = false): number | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/present|current|ongoing|till date|to date|now/.test(s)) return now.getFullYear() * 12 + now.getMonth();
  let m = s.match(/([a-z]{3,9})\.?\s*,?\s*((?:19|20)\d{2})/);
  if (m && MONTHS[m[1]!.slice(0, 4)] != null) return Number(m[2]) * 12 + MONTHS[m[1]!.slice(0, 4)]!;
  if (m && MONTHS[m[1]!.slice(0, 3)] != null) return Number(m[2]) * 12 + MONTHS[m[1]!.slice(0, 3)]!;
  m = s.match(/\b(\d{1,2})\s*[/.-]\s*((?:19|20)\d{2})\b/);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return Number(m[2]) * 12 + Number(m[1]) - 1;
  m = s.match(/\b((?:19|20)\d{2})\s*[/.-]\s*(\d{1,2})\b/);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return Number(m[1]) * 12 + Number(m[2]) - 1;
  m = s.match(/\b((?:19|20)\d{2})\b/);
  if (m) return Number(m[1]) * 12 + (end ? 11 : 0);
  return null;
}

/** Union of month intervals [a, b) in months. */
export function unionMonths(spans: Array<[number, number]>): number {
  const s = [...spans].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of s) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** CV text block describing one role: from its title to the next role's title. */
function dutyBlocks(titles: string[], cvText: string | null): string[] {
  if (!cvText) return titles.map(() => "");
  const lower = cvText.toLowerCase();
  const starts = titles.map((t) => {
    const key = t.trim().toLowerCase();
    if (key.length < 4) return -1;
    const m = new RegExp(escapeRe(key).replace(/\s+/g, "\\s+")).exec(lower);
    return m ? m.index : -1;
  });
  const sorted = [...new Set(starts.filter((i) => i >= 0))].sort((a, b) => a - b);
  return starts.map((i) => {
    if (i < 0) return "";
    const next = sorted.find((j) => j > i);
    return cvText.slice(i, Math.min(next ?? cvText.length, i + 2500));
  });
}

const NON_COURSE = /thesis|dissertation|research (methodology|methods|project)|seminar|internship|^project$/i;
const GENERIC_CIVIL = /civil|infrastructure|construction/i;

/* ------------------------------ input ----------------------------- */

export type SpecialisationInput = {
  rows: ExtractedSubjectRow[];
  qualifications: Array<{ degreeLevel: string; degreeTitle: string | null; institution: string | null }>;
  experienceRows: Array<{
    title?: string | null;
    start?: string | null;
    end?: string | null;
    domainFinal?: boolean | null;
    domainSuggested?: boolean | null;
  }>;
  cvText: string | null;
  now?: Date;
};

/** Civil family codes on the result that make the check relevant. */
export const CIVIL_FAMILY_CODES = ["233211", "233212", "233214", "233215"];

export function specialisationApplies(input: {
  candidateCodes: string[];
  qualifications: Array<{ degreeLevel: string; degreeTitle: string | null }>;
}): boolean {
  if (input.candidateCodes.some((c) => CIVIL_FAMILY_CODES.includes(c))) return true;
  return input.qualifications.some(
    (q) => q.degreeLevel === "bachelor" && /civil/i.test(q.degreeTitle ?? ""),
  );
}

/* ------------------------------ main ------------------------------ */

export function assessSpecialisations(input: SpecialisationInput): SpecialisationResult {
  const now = input.now ?? new Date();
  const audit: SpecialisationAuditEntry[] = [];
  const bachelorRows = input.rows.filter((r) => r.qualification === "bachelor");
  const bachelor = (bachelorRows.length
    ? bachelorRows
    : input.rows.filter((r) => r.qualification === "unknown")
  ).map((r) => r.name);
  const masterSubjects = input.rows.filter((r) => r.qualification === "master").map((r) => r.name);
  const bachelorQual = input.qualifications.find((q) => q.degreeLevel === "bachelor");
  const masterQual = input.qualifications.find((q) => q.degreeLevel === "master");

  const core = coverage(CIVIL_CORE, bachelor);
  const coreMet = core.missing.length === 0;
  audit.push({
    step: "Civil core (Bachelor's)",
    detail: `${core.matched.length}/${CIVIL_CORE.length} core areas covered${
      core.missing.length ? `; missing: ${core.missing.join(", ")}` : ""
    }.${coreMet ? "" : " Specialisation pathways not evaluated (doc 12 §2.2)."}`,
  });

  // Experience rows → months, FTE (part-time 0.5), duty blocks from the CV.
  const rows = input.experienceRows.filter((r) => (r.title ?? "").trim());
  const blocks = dutyBlocks(rows.map((r) => r.title ?? ""), input.cvText);
  let timelineConsistent = rows.length > 0;
  const parsed = rows.map((r, i) => {
    const a = monthIndex(r.start, now);
    const bEnd = monthIndex(r.end, now, true);
    const b = bEnd != null ? bEnd + 1 : null;
    if (a == null || b == null || b <= a || a > now.getFullYear() * 12 + now.getMonth()) timelineConsistent = false;
    const title = (r.title ?? "").trim();
    const engineering = (r.domainFinal ?? r.domainSuggested) !== false;
    return {
      title,
      start: r.start ?? null,
      end: r.end ?? null,
      span: a != null && b != null && b > a ? ([a, b] as [number, number]) : null,
      fte: /part[\s-]?time/i.test(`${title} ${blocks[i]!.slice(0, 200)}`) ? 0.5 : 1,
      engineering,
      block: blocks[i]!,
    };
  });
  const engineeringSpans = parsed.filter((p) => p.engineering && p.span);
  const totalMonths = unionMonths(engineeringSpans.map((p) => p.span!));

  const specialisations = SPECIALISATIONS.map((def): SpecialisationOutcome => {
    const baseCov = coverage(def.base, bachelor);
    const baseLevel: "full" | "partial" | "little" =
      baseCov.coveragePct >= BASE_FULL_PCT ? "full" : baseCov.coveragePct >= BASE_LITTLE_PCT ? "partial" : "little";
    const academicTier: SpecialisationTier = !coreMet
      ? "high_risk"
      : baseLevel === "full"
        ? "no_risk"
        : baseLevel === "partial"
          ? "slight_risk"
          : "high_risk";

    /* ---------- Pathway A: Master's ---------- */
    const aNotes: string[] = [];
    const mTitle = masterQual?.degreeTitle?.trim() || null;
    const titleFit: PathwayAResult["titleFit"] = !masterQual
      ? "none"
      : mTitle && def.masterTitle.test(mTitle)
        ? "specific"
        : mTitle && GENERIC_CIVIL.test(mTitle)
          ? "generic"
          : "unrelated";
    const counted = masterSubjects.filter((s) => !NON_COURSE.test(s.trim()));
    const aMatched: TaxonomyHit[] = [];
    const aUnmatched: string[] = [];
    for (const s of counted) {
      if (def.masterCourse.test(s)) {
        const baseHit = def.base.find((t) => t.re.test(s));
        aMatched.push({ item: baseHit?.item ?? "Specialisation subject", evidence: s, confidence: baseHit ? 1 : 0.8 });
      } else aUnmatched.push(s);
    }
    const coursePct = counted.length ? pct(aMatched.length, counted.length) : null;
    const titleScore = titleFit === "specific" ? 1 : titleFit === "generic" ? 0.5 : 0;
    const relevanceA = masterQual
      ? Math.round((0.4 * titleScore + 0.6 * ((coursePct ?? 0) / 100)) * 1000) / 10
      : 0;
    let tierA: SpecialisationTier = "high_risk";
    if (!masterQual) aNotes.push("No Master's degree on the case.");
    else if (coursePct == null) {
      aNotes.push("Master's subjects not extracted — coursework share cannot be checked.");
      tierA = titleFit === "specific" ? "slight_risk" : "high_risk";
    } else if (titleFit === "specific" && coursePct >= MASTER_PREDOMINANT_PCT) tierA = "no_risk";
    else if (titleFit !== "unrelated" && coursePct >= MASTER_PART_PCT) {
      tierA = "slight_risk";
      if (titleFit === "generic") aNotes.push(`Master's title is generic, not specifically ${def.title.replace(" Engineer", "")}.`);
      if (coursePct < MASTER_PREDOMINANT_PCT) aNotes.push("Only part of the Master's coursework is specialisation-specific.");
    } else {
      aNotes.push(
        titleFit === "unrelated"
          ? "Master's is in an unrelated field."
          : "Master's coursework only touches the specialisation incidentally.",
      );
    }
    const pathwayA: PathwayAResult = {
      available: !!masterQual,
      degreeTitle: mTitle,
      titleFit,
      subjectsCounted: counted.length,
      matched: aMatched,
      unmatched: aUnmatched,
      coursePct,
      relevancePct: relevanceA,
      satisfied: tierA !== "high_risk",
      tier: tierA,
      notes: aNotes,
    };

    /* ---------- Pathway B: work experience ---------- */
    const bNotes: string[] = [];
    const compHits = new Map<string, TaxonomyHit>();
    const roles: PathwayBRole[] = parsed.map((p) => {
      const specialistTitle = def.roleTitle.test(p.title);
      const comps = def.competencies.filter((c) => c.re.test(p.block)).map((c) => c.item);
      const dutyShare = comps.length / def.competencies.length;
      // Specialisation title: 0.6 + duties; generic title: duties only (≥ 2 needed).
      const relevance = !p.engineering
        ? 0
        : specialistTitle
          ? 0.6 + 0.4 * dutyShare
          : comps.length >= 2
            ? dutyShare
            : 0;
      const months = p.span ? p.span[1] - p.span[0] : 0;
      const countedRole = relevance >= ROLE_COUNTED_RELEVANCE && !!p.span;
      if (countedRole || specialistTitle) {
        for (const c of comps) {
          if (!compHits.has(c)) compHits.set(c, { item: c, evidence: p.title, confidence: specialistTitle ? 1 : 0.8 });
        }
      }
      return {
        title: p.title,
        start: p.start,
        end: p.end,
        months,
        fte: p.fte,
        specialistTitle,
        competencies: comps,
        relevance: Math.round(relevance * 100) / 100,
        counted: countedRole,
      };
    });
    // FTE years: overlapping roles are counted once; part-time roles at 0.5.
    const ftMonths = unionMonths(parsed.filter((p, i) => roles[i]!.counted && p.fte === 1).map((p) => p.span!));
    const ptMonths = unionMonths(parsed.filter((p, i) => roles[i]!.counted && p.fte < 1).map((p) => p.span!));
    const fteYears = Math.round(((ftMonths + 0.5 * ptMonths) / 12) * 10) / 10;
    const weighted = roles.reduce((s, r) => s + r.months * r.fte * r.relevance, 0);
    const allFte = parsed.reduce((s, p, i) => s + (p.engineering ? roles[i]!.months * p.fte : 0), 0);
    const relevanceB = allFte > 0 ? Math.min(100, Math.round((weighted / allFte) * 1000) / 10) : 0;
    const competencyPct = pct(compHits.size, def.competencies.length);
    const anySpecialistTitle = roles.some((r) => r.specialistTitle && r.counted);
    let tierB: SpecialisationTier = "high_risk";
    if (!rows.length) bNotes.push("No work experience on the case.");
    else if (fteYears < PATHWAY_B_YEARS) bNotes.push(`${fteYears} FTE years in the specialisation (5 needed).`);
    else if (relevanceB >= 75 && anySpecialistTitle && competencyPct >= 50 && timelineConsistent) {
      // §4 No Risk also needs verifiable, detailed reference letters, which are
      // not stored in the system: best outcome is Slight Risk until the assessor
      // confirms them.
      tierB = "slight_risk";
      bNotes.push("Reference letters are not on file — confirm they are detailed and verifiable.");
    } else if (relevanceB >= 50 && competencyPct > 0) {
      tierB = "slight_risk";
      if (!anySpecialistTitle) bNotes.push("Role titles are generalist civil; duties only partly in the specialisation.");
      if (competencyPct < 50) bNotes.push("Duties are described briefly / with little specialisation detail.");
      if (!timelineConsistent) bNotes.push("Employment dates are missing or inconsistent.");
      bNotes.push("Reference letters are not on file — confirm they are detailed and verifiable.");
    } else bNotes.push("Little specialisation-specific technical work in the CV duties.");
    const pathwayB: PathwayBResult = {
      available: rows.length > 0,
      fteYears,
      totalYears: Math.round((totalMonths / 12) * 10) / 10,
      relevancePct: relevanceB,
      competencyPct,
      roles,
      competenciesMatched: [...compHits.values()],
      competenciesMissing: def.competencies.map((c) => c.item).filter((c) => !compHits.has(c)),
      referenceLetters: "not_in_system",
      timelineConsistent,
      satisfied: tierB !== "high_risk",
      tier: tierB,
      notes: bNotes,
    };

    /* ---------- choose pathway, score, tier ---------- */
    let chosen: "A" | "B" | null = null;
    let tier: SpecialisationTier = "high_risk";
    let score = 0;
    const gaps: string[] = [];
    if (!coreMet) {
      gaps.push(`Civil core not covered: ${core.missing.join(", ")}.`);
    } else {
      const rankA = TIER_RANK[tierA] * 1000 - relevanceA;
      const rankB = TIER_RANK[tierB] * 1000 - relevanceB;
      chosen = rankA <= rankB ? "A" : "B";
      if (!pathwayA.available && pathwayB.available) chosen = "B";
      if (!pathwayB.available && pathwayA.available) chosen = "A";
      const used = chosen === "A" ? pathwayA : pathwayB;
      // Evidence quality (doc 12 §2.4): institution recognised (named),
      // employment dates consistent, reference letters (Pathway B only).
      const checks: number[] = [bachelorQual?.institution?.trim() ? 1 : 0];
      if (chosen === "B") checks.push(timelineConsistent ? 1 : 0, 0.5);
      else if (masterQual) checks.push(masterQual.institution?.trim() ? 1 : 0);
      const evidence = (checks.reduce((s, c) => s + c, 0) / checks.length) * 100;
      score = Math.round((0.7 * used.relevancePct + 0.3 * evidence) * 10) / 10;
      const scoreTier: SpecialisationTier =
        score >= SCORE_NO_RISK ? "no_risk" : score >= SCORE_SLIGHT_RISK ? "slight_risk" : "high_risk";
      tier = worse(academicTier, used.tier, scoreTier);
      if (baseLevel !== "full") gaps.push(`${def.title} base subjects missing: ${baseCov.missing.join(", ")}.`);
      gaps.push(...used.notes);
      if (chosen === "B" && pathwayB.competenciesMissing.length && tier !== "no_risk") {
        gaps.push(`Duties not evidenced: ${pathwayB.competenciesMissing.join(", ")}.`);
      }
      if (!bachelorQual?.institution?.trim()) gaps.push("Bachelor's institution not recorded.");
    }
    const routing =
      tier === "no_risk"
        ? "Pass to assessor for expedited sign-off."
        : tier === "slight_risk"
          ? "Pass to assessor with the gaps listed; request supplementary evidence."
          : "Recommend rejection or request further documentation.";
    audit.push({
      step: def.title,
      detail: coreMet
        ? `Base ${baseCov.matched.length}/${def.base.length}; Pathway A ${relevanceA}% (${tierA}); Pathway B ${relevanceB}% over ${fteYears} FTE yrs (${tierB}); used ${chosen}; score ${score}; ${tier}.`
        : "Not evaluated (Civil core not met); high_risk.",
    });
    return {
      anzscoCode: def.anzscoCode,
      title: def.title,
      base: { ...baseCov, level: baseLevel },
      pathwayA,
      pathwayB,
      chosen,
      academicTier,
      score,
      tier,
      gaps,
      routing,
    };
  });

  return {
    version: SPECIALISATION_VERSION,
    computedAt: now.toISOString(),
    civilCore: { ...core, met: coreMet },
    specialisations,
    audit,
  };
}
