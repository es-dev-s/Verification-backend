import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const subjectSchema = z.object({
  name: z.string(),
  category: z.string(),
  variants: z.array(z.string()).default([]),
  /**
   * Set when this heading's sheet variants come from an anzsco_subjects.json row that
   * is linked to several rubric headings (its "id" plus "alsoIds"); the value is that
   * row's primary id. matchSubjects lets one transcript subject credit only one
   * heading per shared row.
   */
  sharedVariantsFrom: z.string().optional(),
});

const rubricSchema = z.object({
  anzscoCode: z.string(),
  title: z.string(),
  /** Stable occupation key from anzsco-verification-rubrics.json (unique even when ANZSCO is shared). */
  occupationId: z.string().optional(),
  format: z.string().optional(),
  rubricVersion: z.string().optional(),
  qualificationCheck: z
    .object({
      requirement: z.string(),
      exampleTitles: z.array(z.string()).default([]),
      /**
       * "bachelor_expected" (default, professional engineer flows): a
       * diploma-level-only qualification is capped at conditional.
       * "diploma_ok": Diploma / Advanced Diploma / Associate Degree are valid.
       */
      levelPolicy: z.enum(["bachelor_expected", "diploma_ok"]).optional(),
      /**
       * Qualification-title check: every group must have one word present
       * ("draft*" = prefix). Missing / failing title → capped at conditional.
       */
      titleCheck: z.object({ allOf: z.array(z.array(z.string())) }).optional(),
    })
    .optional(),
  /** Occupation-specific matching switches (see matchSubjects). */
  matching: z
    .object({
      /** One combined course ("CAD and Solid Modelling") may satisfy several rows. */
      combinedCourses: z.boolean().optional(),
    })
    .optional(),
  tiers: z.object({
    tier1: z.object({
      label: z.string(),
      scoreDenominator: z.number(),
      subjects: z.array(subjectSchema),
    }),
    tier2: z.object({
      label: z.string(),
      scoreDenominator: z.number(),
      subjects: z.array(subjectSchema),
    }),
    tier3: z.object({
      label: z.string(),
      gate: z
        .object({
          rule: z.string().optional(),
          gateSubject: z.string(),
          /**
           * When set, the generic project/thesis keyword rule only counts a
           * subject for the gate if its name also has one of these topic words
           * ("draft*" = prefix), e.g. drafting / design / CAD for 312511.
           */
          keywordRuleRequires: z.array(z.string()).optional(),
        })
        .optional(),
      subjects: z.array(subjectSchema),
    }),
  }),
  riskScoring: z.object({
    tier1: z.object({
      thresholds: z.array(
        z.object({
          matchedRange: z.tuple([z.number(), z.number()]),
          outcome: z.string(),
          label: z.string(),
          action: z.string().optional(),
        }),
      ),
    }),
    tier2: z.object({
      thresholds: z.array(
        z.object({
          matchedRange: z.tuple([z.number(), z.number()]),
          outcome: z.string(),
          label: z.string(),
          action: z.string().optional(),
        }),
      ),
    }),
    overallDetermination: z.object({
      note: z.string().optional(),
      combinationTable: z.array(
        z.object({
          tier1Outcome: z.array(z.string()),
          tier2Outcome: z.array(z.string()),
          result: z.string(),
          label: z.string(),
        }),
      ),
      /** When true, missing Tier 3 gate only downgrades verified → conditional. */
      tier3GateDowngradeVerifiedOnly: z.boolean().optional(),
    }),
  }),
});

export type Rubric = z.infer<typeof rubricSchema>;
export type RubricSubject = z.infer<typeof subjectSchema> & {
  tier: "tier1" | "tier2" | "tier3";
};

type NamedSubject = {
  /** Fixed heading id, e.g. "233212-T2.3" — shared with the matching anzsco_subjects.json row. */
  id?: string;
  name?: string;
  label?: string;
  status?: string;
  aliases?: string[];
  /** Free-text assessor note, e.g. "Includes Mathematics I/II/III, Numerical Methods, etc." */
  matchingNote?: string;
};
type OccupationRaw = {
  id: string;
  anzsco: string;
  title: string;
  flow: string;
  qualification?: {
    statement?: string;
    levelPolicy?: "bachelor_expected" | "diploma_ok";
    titleCheck?: { allOf: string[][] };
    /** Vocational flows: accepted training-package qualification codes (e.g. UEE62122). */
    codes?: string[];
    /** Vocational flows: qualification-title words for routing (every group needs one word). */
    titleMatch?: { allOf: string[][] };
  };
  /** Vocational flows: false keeps the occupation out of scoring. */
  scoringEnabled?: boolean;
  scoringDisabledReason?: string;
  reviewFlags?: Array<{ severity?: string; field?: string; message: string }>;
  coreUnits?: {
    total: number;
    thresholds: Record<string, number>;
    units: VocationalUnitRaw[];
  };
  electives?: {
    clusters?: string[];
    minimumUnits?: number | null;
    rule?: string;
  };
  matching?: { combinedCourses?: boolean };
  tier1?: {
    total: number;
    thresholds: Record<string, number>;
    subjects?: NamedSubject[];
  };
  tier2?: {
    total: number;
    thresholds: Record<string, number>;
    core?: NamedSubject[];
    optional?: NamedSubject[];
  };
  tier3?: {
    gate?: {
      id?: string;
      label?: string;
      aliases?: string[];
      keywordRuleRequires?: string[];
    };
    supporting?: NamedSubject[];
    optional?: NamedSubject[];
    onGateMissing?: string;
  };
  source?: { version?: string };
};

/** Equivalent / superseded unit code, taken from training.gov.au (with source URL). */
export type UnitCodeMapping = {
  code: string;
  relation: string;
  title?: string;
  mappingDate?: string;
  source: string;
};

export type VocationalUnitRaw = {
  id: string;
  code: string | null;
  title: string;
  placeholder?: boolean;
  /** Title as published on training.gov.au (may differ from the rubric doc). */
  tgaTitle?: string;
  tgaStatus?: string;
  /** Codes training.gov.au marks as equivalent (count as a match). */
  equivalentCodes?: UnitCodeMapping[];
  /** Codes training.gov.au maps without equivalence (shown, never counted). */
  nonEquivalentCodes?: UnitCodeMapping[];
  /** Known typo spellings of this code that are accepted and flagged. */
  typoAliases?: string[];
  equivalenceNote?: string;
};

/** One vocational (unit-code) occupation, as read from the rubric file. */
export type VocationalOccupation = {
  id: string;
  anzsco: string;
  title: string;
  qualificationStatement: string;
  qualificationCodes: string[];
  titleMatch: string[][];
  coreUnits: { total: number; thresholds: Record<string, number>; units: VocationalUnitRaw[] };
  electives: { clusters: string[]; minimumUnits: number | null; rule: string | null };
  /** True only when scoring is switched on and every core unit has a real code. */
  scoringEnabled: boolean;
  /** Why scoring is off (null when enabled). */
  disabledReason: string | null;
  reviewFlags: Array<{ severity?: string; field?: string; message: string }>;
  version?: string;
  /** Flow determination rules (core band × elective status → result). */
  determinationRules: Array<{ when: { coreUnits?: string[]; electives?: string[] }; result: string }>;
};

type FlowRaw = {
  determinationRules?: Array<{
    when: { tier1?: string[]; tier2?: string[]; coreUnits?: string[]; electives?: string[] };
    result: string;
  }>;
  postStep?: {
    name?: string;
    ifGateMissingAndResultIs?: string;
    thenResult?: string;
  };
};

type RubricsFile = {
  defaults?: {
    outcomes?: {
      tier1?: Record<string, { label?: string; action?: string }>;
      tier2?: Record<string, { label?: string; action?: string }>;
    };
  };
  flows: Record<string, FlowRaw>;
  occupations: OccupationRaw[];
};

type SubjectsEntry = {
  anzscoCode: string | null;
  title: string;
  /** Rubric occupation id; needed because ANZSCO 233999 is shared by two occupations. */
  occupationId?: string;
  groups?: Record<
    string,
    {
      subjects?: Array<{
        id?: string;
        /** Further rubric heading ids this row is linked to (one sheet heading covering several rubric rows). */
        alsoIds?: string[];
        name: string;
        variants?: string[];
      }>;
    }
  >;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, "../lib");

let rubricsFile: RubricsFile | null = null;
let subjectsFile: SubjectsEntry[] | null = null;
let rubricFingerprintCache: string | null = null;
let idLinkCheckDone = false;
const rubricCache = new Map<string, Rubric>();

const OUTCOME_MAP: Record<string, string> = {
  noRisk: "no_risk",
  lowRisk: "low_risk",
  flag: "flag",
  medium: "medium_risk",
  high: "high_risk",
  verified: "verified_no_risk",
  notVerified: "not_verified",
  conditional: "conditional",
};

/**
 * Stable hash of the rubric + variant JSON files. Part of the assessment cache
 * key so a rubric edit invalidates cached scores.
 */
export function rubricFingerprint(): string {
  if (rubricFingerprintCache) return rubricFingerprintCache;
  const h = createHash("sha256");
  for (const name of ["anzsco-verification-rubrics.json", "anzsco_subjects.json"]) {
    h.update(name);
    h.update("\0");
    h.update(readFileSync(resolve(libDir, name)));
    h.update("\0");
  }
  rubricFingerprintCache = h.digest("hex").slice(0, 16);
  return rubricFingerprintCache;
}

/**
 * Turn a rubric matchingNote into extra synonyms.
 * "Includes Engineering/Applied/General Chemistry variants." →
 *   ["Engineering Chemistry", "Applied Chemistry", "General Chemistry"]
 * Notes that say the subject is not used for suitability yield nothing.
 */
export function synonymsFromMatchingNote(note: string | undefined): string[] {
  if (!note?.trim()) return [];
  if (/not used/i.test(note)) return [];
  let text = note
    .replace(/\s+[—–-]\s+.*$/s, "") // drop trailing commentary after a dash
    .replace(/\([^)]*\)/g, " ")
    .replace(/^\s*includes?\s+/i, "")
    .replace(/\betc\.?/gi, " ")
    .replace(/\band similar\b.*$/i, " ")
    .replace(/\bvariants?\b\.?/gi, " ")
    .replace(/\.\s*$/, " ");
  text = text.replace(/\s+/g, " ").trim();
  const out = new Set<string>();
  for (const pieceRaw of text.split(/\s*[,;]\s*|\s+\/\s+|\s+and\s+(?=[A-Z])/)) {
    const piece = pieceRaw.trim().replace(/^and\s+/i, "");
    if (!piece) continue;
    for (const v of expandSlashAlternatives(piece)) {
      const t = v.trim();
      const words = t.split(/\s+/);
      if (t.length < 4 && !/^[A-Z]{3,}$/.test(t)) continue;
      if (words.length === 1 && /^(engineering|engineers?|general|applied|basic|lab|laboratory)$/i.test(t)) continue;
      out.add(t);
    }
  }
  return [...out];
}

/**
 * "Engineering/Applied/General Chemistry" → three names;
 * "Physics I/II" and "Mathematics I/II/III" keep roman numerals attached to the base.
 */
function expandSlashAlternatives(piece: string): string[] {
  const words = piece.split(/\s+/);
  const idx = words.findIndex((w) => w.includes("/"));
  if (idx < 0) return [piece];
  const alts = words[idx]!.split("/").filter(Boolean);
  if (alts.every((a) => /^(I|II|III|IV|V|VI|\d+)$/i.test(a))) {
    const base = words.slice(0, idx).join(" ");
    return alts.map((a) => `${base} ${a}`.trim());
  }
  return alts.flatMap((a) =>
    expandSlashAlternatives(
      [...words.slice(0, idx), a, ...words.slice(idx + 1)].join(" "),
    ),
  );
}

function loadRubricsFile(): RubricsFile {
  if (rubricsFile) return rubricsFile;
  const path = resolve(libDir, "anzsco-verification-rubrics.json");
  rubricsFile = JSON.parse(readFileSync(path, "utf8")) as RubricsFile;
  return rubricsFile;
}

function loadSubjectsFile(): SubjectsEntry[] {
  if (subjectsFile) return subjectsFile;
  const path = resolve(libDir, "anzsco_subjects.json");
  subjectsFile = JSON.parse(readFileSync(path, "utf8")) as SubjectsEntry[];
  return subjectsFile;
}

function mapOutcome(raw: string): string {
  return OUTCOME_MAP[raw] ?? raw;
}

function subjectName(s: NamedSubject): string {
  return (s.name ?? s.label ?? "").trim();
}

/** Build inclusive matchedRange bands from minimum-threshold maps. */
function thresholdsToRanges(
  total: number,
  thresholds: Record<string, number>,
  kind: "tier1" | "tier2",
  outcomeMeta?: Record<string, { label?: string; action?: string }>,
): Array<{
  matchedRange: [number, number];
  outcome: string;
  label: string;
  action?: string;
}> {
  const order =
    kind === "tier1"
      ? (["noRisk", "lowRisk"] as const)
      : (["noRisk", "lowRisk", "medium"] as const);
  const bands: Array<{
    matchedRange: [number, number];
    outcome: string;
    label: string;
    action?: string;
  }> = [];

  let upper = total;
  for (const key of order) {
    const min = thresholds[key];
    if (min == null) continue;
    const lo = min;
    const hi = upper;
    if (lo > hi) continue;
    const outcome = mapOutcome(key);
    const meta = outcomeMeta?.[key];
    bands.push({
      matchedRange: [lo, hi],
      outcome,
      label: meta?.label ?? outcome.replace(/_/g, " "),
      action: meta?.action,
    });
    upper = min - 1;
  }

  const fallbackKey = kind === "tier1" ? "flag" : "high";
  const fallbackOutcome = mapOutcome(fallbackKey);
  const meta = outcomeMeta?.[fallbackKey];
  if (upper >= 0) {
    bands.push({
      matchedRange: [0, upper],
      outcome: fallbackOutcome,
      label: meta?.label ?? fallbackOutcome.replace(/_/g, " "),
      action: meta?.action,
    });
  }

  return bands;
}

function determinationTable(flow: FlowRaw): Rubric["riskScoring"]["overallDetermination"]["combinationTable"] {
  const rules = flow.determinationRules ?? [];
  const table: Rubric["riskScoring"]["overallDetermination"]["combinationTable"] =
    [];

  for (const rule of rules) {
    const tier1 = (rule.when.tier1 ?? ["noRisk", "lowRisk", "flag"]).map(
      mapOutcome,
    );
    const tier2 = (rule.when.tier2 ?? []).map(mapOutcome);
    if (!tier2.length) continue;
    table.push({
      tier1Outcome: tier1,
      tier2Outcome: tier2,
      result: mapOutcome(rule.result),
      label: mapOutcome(rule.result).replace(/_/g, " "),
    });
  }
  return table;
}

/**
 * The anzsco_subjects.json entry for a rubric occupation: by occupationId, else by
 * ANZSCO code when exactly one entry has that code. No title / name guessing.
 */
function subjectsEntryForOccupation(
  occupation: OccupationRaw,
  entries: SubjectsEntry[] = loadSubjectsFile(),
): SubjectsEntry | undefined {
  const byId = entries.find((e) => e.occupationId === occupation.id);
  if (byId) return byId;
  const byCode = entries.filter(
    (e) =>
      !e.occupationId &&
      e.anzscoCode != null &&
      String(e.anzscoCode) === String(occupation.anzsco),
  );
  return byCode.length === 1 ? byCode[0] : undefined;
}

/** Every heading id a subjects-file row is linked to: "id" first, then "alsoIds". */
function sheetRowIds(s: { id?: string; alsoIds?: string[] }): string[] {
  return [s.id, ...(s.alsoIds ?? [])]
    .map((x) => x?.trim() ?? "")
    .filter(Boolean);
}

/** Subjects-only headings ("<code>-T<k>.X<n>") are expected to have no rubric row. */
const SUBJECTS_ONLY_ID = /^\d+-T\d+\.X\d+$/;

type VariantsIndex = Map<string, Set<string>> & {
  /** Heading id → primary id of the shared sheet row it draws variants from. */
  sharedFrom?: Map<string, string>;
};

/** Variants keyed by heading id (rows sharing an id are merged; "alsoIds" share a row). */
function variantsIndexForOccupation(
  occupation: OccupationRaw,
): VariantsIndex {
  const byId: VariantsIndex = new Map<string, Set<string>>();
  byId.sharedFrom = new Map();
  const match = subjectsEntryForOccupation(occupation);
  if (!match?.groups) return byId;

  for (const group of Object.values(match.groups)) {
    for (const s of group.subjects ?? []) {
      const ids = sheetRowIds(s);
      if (!ids.length) continue;
      for (const id of ids) {
        if (!byId.has(id)) byId.set(id, new Set());
        if (ids.length > 1) byId.sharedFrom.set(id, ids[0]!);
        for (const v of s.variants ?? []) {
          const t = v.trim();
          if (t) byId.get(id)!.add(t);
        }
      }
    }
  }
  return byId;
}

/** Rubric heading ids of one academic occupation, in rubric order. */
function rubricHeadingIds(occupation: OccupationRaw): string[] {
  const rows: Array<{ id?: string } | undefined> = [
    ...(occupation.tier1?.subjects ?? []),
    ...(occupation.tier2?.core ?? []),
    ...(occupation.tier2?.optional ?? []),
    occupation.tier3?.gate,
    ...(occupation.tier3?.supporting ?? []),
    ...(occupation.tier3?.optional ?? []),
  ];
  return rows.map((r) => r?.id?.trim() ?? "").filter(Boolean);
}

export type SubjectIdLinkReport = {
  occupationId: string;
  anzsco: string;
  /** No anzsco_subjects.json entry joins to this occupation. */
  noSubjectsEntry: boolean;
  /** Rubric rows that have no id at all. */
  rubricRowsWithoutId: number;
  /** Rubric ids with no anzsco_subjects.json row (the heading gets no sheet variants). */
  missingInSubjects: string[];
  /**
   * anzsco_subjects.json ids that no rubric row uses (variants never loaded). Subjects-only
   * "X" ids are by design and not listed here.
   */
  missingInRubric: string[];
  /** Number of subjects-only "X" headings (informational, not warned). */
  subjectsOnly: number;
};

/**
 * Compare heading ids between the two JSON files, per academic occupation.
 * Only reports — never throws.
 */
export function checkSubjectIdLinks(
  rubrics: RubricsFile = loadRubricsFile(),
  entries: SubjectsEntry[] = loadSubjectsFile(),
): SubjectIdLinkReport[] {
  const out: SubjectIdLinkReport[] = [];
  for (const o of rubrics.occupations) {
    if (o.flow !== "academic_3_tier") continue;
    const ids = rubricHeadingIds(o);
    const rubricRowCount =
      (o.tier1?.subjects?.length ?? 0) +
      (o.tier2?.core?.length ?? 0) +
      (o.tier2?.optional?.length ?? 0) +
      (o.tier3?.gate ? 1 : 0) +
      (o.tier3?.supporting?.length ?? 0) +
      (o.tier3?.optional?.length ?? 0);
    const entry = subjectsEntryForOccupation(o, entries);
    const sheetIds = new Set<string>();
    for (const g of Object.values(entry?.groups ?? {})) {
      for (const s of g.subjects ?? []) for (const id of sheetRowIds(s)) sheetIds.add(id);
    }
    const rubricIds = new Set(ids);
    out.push({
      occupationId: o.id,
      anzsco: String(o.anzsco),
      noSubjectsEntry: !entry,
      rubricRowsWithoutId: rubricRowCount - ids.length,
      missingInSubjects: ids.filter((id) => !sheetIds.has(id)),
      missingInRubric: [...sheetIds].filter(
        (id) => !rubricIds.has(id) && !SUBJECTS_ONLY_ID.test(id),
      ),
      subjectsOnly: [...sheetIds].filter((id) => SUBJECTS_ONLY_ID.test(id)).length,
    });
  }
  return out;
}

/** console.warn one line per occupation whose ids do not line up. */
export function warnSubjectIdMismatches(
  report: SubjectIdLinkReport[] = checkSubjectIdLinks(),
  warn: (msg: string) => void = console.warn,
): number {
  let warned = 0;
  for (const r of report) {
    const parts: string[] = [];
    if (r.noSubjectsEntry) parts.push("no anzsco_subjects.json entry");
    if (r.rubricRowsWithoutId) parts.push(`${r.rubricRowsWithoutId} rubric row(s) without id`);
    if (r.missingInSubjects.length) {
      parts.push(`only in rubrics: ${r.missingInSubjects.join(", ")}`);
    }
    if (r.missingInRubric.length) {
      parts.push(`only in subjects file: ${r.missingInRubric.join(", ")}`);
    }
    if (!parts.length) continue;
    warned++;
    warn(`[rubric ids] ${r.occupationId} (${r.anzsco}): ${parts.join("; ")}`);
  }
  return warned;
}

function withVariants(
  id: string | undefined,
  name: string,
  category: string,
  byId: VariantsIndex,
  extra: string[] = [],
): z.infer<typeof subjectSchema> {
  const set = new Set<string>(extra);
  const fromFile = id ? byId.get(id.trim()) : undefined;
  if (fromFile) for (const v of fromFile) set.add(v);
  const shared = id ? byId.sharedFrom?.get(id.trim()) : undefined;
  return { name, category, variants: [...set], ...(shared ? { sharedVariantsFrom: shared } : {}) };
}

function buildRubricFromOccupation(occupation: OccupationRaw): Rubric {
  const file = loadRubricsFile();
  const flow = file.flows[occupation.flow];
  if (!flow) {
    throw new Error(
      `Unknown flow "${occupation.flow}" for occupation ${occupation.id}`,
    );
  }
  if (occupation.flow !== "academic_3_tier") {
    throw new Error(
      `Occupation ${occupation.id} uses flow "${occupation.flow}" which is not supported by the academic scorer`,
    );
  }
  if (!occupation.tier1 || !occupation.tier2) {
    throw new Error(`Occupation ${occupation.id} is missing tier1/tier2`);
  }

  const byId = variantsIndexForOccupation(occupation);
  const defaults = file.defaults?.outcomes;

  const extras = (s: NamedSubject) => [
    ...(s.aliases ?? []),
    ...synonymsFromMatchingNote(s.matchingNote),
  ];

  const tier1Subjects = (occupation.tier1.subjects ?? []).map((s) => {
    const name = subjectName(s);
    const status = (s.status ?? "expected").toLowerCase();
    // "contextual" catch-alls ("Others (general electives)") never count toward tier 1.
    const category =
      status === "optional" || status === "elective"
        ? "optional"
        : status === "contextual"
          ? "contextual"
          : "expected";
    return withVariants(s.id, name, category, byId, extras(s));
  });

  const tier2Subjects = [
    ...(occupation.tier2.core ?? []).map((s) =>
      withVariants(s.id, subjectName(s), "core", byId, extras(s)),
    ),
    ...(occupation.tier2.optional ?? []).map((s) =>
      withVariants(s.id, subjectName(s), "optional", byId, extras(s)),
    ),
  ];

  const gateLabel =
    occupation.tier3?.gate?.label ??
    "Major Project / Thesis / Final-Year Project/ Capstone Project";
  const gateAliases = occupation.tier3?.gate?.aliases ?? [];

  const tier3Subjects = [
    withVariants(occupation.tier3?.gate?.id, gateLabel, "core", byId, gateAliases),
    ...(occupation.tier3?.supporting ?? []).map((s) =>
      withVariants(s.id, subjectName(s), "core", byId, extras(s)),
    ),
    ...(occupation.tier3?.optional ?? []).map((s) =>
      withVariants(s.id, subjectName(s), "optional", byId, extras(s)),
    ),
  ];

  const raw: Rubric = {
    anzscoCode: String(occupation.anzsco),
    title: occupation.title,
    occupationId: occupation.id,
    format: "academic",
    rubricVersion: occupation.source?.version,
    qualificationCheck: occupation.qualification?.statement
      ? {
          requirement: occupation.qualification.statement,
          exampleTitles: [],
          ...(occupation.qualification.levelPolicy
            ? { levelPolicy: occupation.qualification.levelPolicy }
            : {}),
          ...(occupation.qualification.titleCheck
            ? { titleCheck: occupation.qualification.titleCheck }
            : {}),
        }
      : undefined,
    ...(occupation.matching ? { matching: occupation.matching } : {}),
    tiers: {
      tier1: {
        label: "Foundation Engineering Knowledge",
        scoreDenominator: occupation.tier1.total,
        subjects: tier1Subjects,
      },
      tier2: {
        label: `Core ${occupation.title} Knowledge`,
        scoreDenominator: occupation.tier2.total,
        subjects: tier2Subjects,
      },
      tier3: {
        label: "Engineering Application (Project / Practical)",
        gate: {
          rule:
            occupation.tier3?.onGateMissing ??
            "Presence of major project/thesis/capstone is required for auto-approve.",
          gateSubject: gateLabel,
          ...(occupation.tier3?.gate?.keywordRuleRequires?.length
            ? { keywordRuleRequires: occupation.tier3.gate.keywordRuleRequires }
            : {}),
        },
        subjects: tier3Subjects,
      },
    },
    riskScoring: {
      tier1: {
        thresholds: thresholdsToRanges(
          occupation.tier1.total,
          occupation.tier1.thresholds,
          "tier1",
          defaults?.tier1,
        ),
      },
      tier2: {
        thresholds: thresholdsToRanges(
          occupation.tier2.total,
          occupation.tier2.thresholds,
          "tier2",
          defaults?.tier2,
        ),
      },
      overallDetermination: {
        note: "Tier 3 acts as a gate; missing gate downgrades verified → conditional.",
        combinationTable: determinationTable(flow),
        tier3GateDowngradeVerifiedOnly:
          flow.postStep?.ifGateMissingAndResultIs === "verified" &&
          flow.postStep?.thenResult === "conditional",
      },
    },
  };

  return rubricSchema.parse(raw);
}

function findOccupation(
  codeOrId: string,
): OccupationRaw {
  const file = loadRubricsFile();
  const key = codeOrId.trim();
  const byId = file.occupations.find((o) => o.id === key);
  if (byId) return byId;
  const byCode = file.occupations.filter(
    (o) => String(o.anzsco) === key && o.flow === "academic_3_tier",
  );
  if (byCode.length === 1) return byCode[0]!;
  if (byCode.length > 1) {
    // Ambiguous ANZSCO (e.g. 233999) — prefer chemical-engineer legacy default only for 233111
    throw new Error(
      `ANZSCO ${key} matches multiple occupations (${byCode.map((o) => o.id).join(", ")}). Pass occupation id instead.`,
    );
  }
  const anyCode = file.occupations.find((o) => String(o.anzsco) === key);
  if (anyCode) return anyCode;
  throw new Error(`No occupation found for "${codeOrId}"`);
}

/** Load and validate a compiled Rubric for one occupation (by id or unique ANZSCO). */
export function loadRubric(codeOrId = "233111"): Rubric {
  if (!idLinkCheckDone) {
    // Startup check: runs once, on the first rubric load. Warns only.
    idLinkCheckDone = true;
    try {
      warnSubjectIdMismatches();
    } catch (err) {
      console.warn("[rubric ids] id check failed:", err);
    }
  }
  const occupation = findOccupation(codeOrId);
  const cached = rubricCache.get(occupation.id);
  if (cached) return cached;
  const rubric = buildRubricFromOccupation(occupation);
  rubricCache.set(occupation.id, rubric);
  return rubric;
}

/** All academic (3-tier) occupations — used for multi-ANZSCO assessment. */
export function listAcademicOccupations(): Array<{
  id: string;
  anzsco: string;
  title: string;
}> {
  return loadRubricsFile()
    .occupations.filter((o) => o.flow === "academic_3_tier")
    .map((o) => ({ id: o.id, anzsco: o.anzsco, title: o.title }));
}

/** Every vocational (unit-code) occupation, enabled or not. */
export function listVocationalOccupations(): VocationalOccupation[] {
  const file = loadRubricsFile();
  return file.occupations
    .filter((o) => o.flow === "vocational_units")
    .map((o) => {
      const units = o.coreUnits?.units ?? [];
      const realCodes =
        units.length > 0 && units.every((u) => !u.placeholder && Boolean(u.code?.trim()));
      const switchedOn = o.scoringEnabled !== false;
      const disabledReason = !realCodes
        ? "Core units have no unit codes yet."
        : !switchedOn
          ? o.scoringDisabledReason ?? "Scoring switched off in the rubric."
          : null;
      return {
        id: o.id,
        anzsco: String(o.anzsco),
        title: o.title,
        qualificationStatement: o.qualification?.statement ?? "",
        qualificationCodes: (o.qualification?.codes ?? []).map((c) => c.trim().toUpperCase()),
        titleMatch: o.qualification?.titleMatch?.allOf ?? [],
        coreUnits: {
          total: o.coreUnits?.total ?? units.length,
          thresholds: o.coreUnits?.thresholds ?? {},
          units,
        },
        electives: {
          clusters: o.electives?.clusters ?? [],
          minimumUnits: o.electives?.minimumUnits ?? null,
          rule: o.electives?.rule ?? null,
        },
        scoringEnabled: realCodes && switchedOn,
        disabledReason,
        reviewFlags: o.reviewFlags ?? [],
        version: o.source?.version,
        determinationRules: (file.flows[o.flow]?.determinationRules ?? []).map((r) => ({
          when: { coreUnits: r.when.coreUnits, electives: r.when.electives },
          result: r.result,
        })),
      };
    });
}

/** Compile rubrics for every academic occupation. */
export function loadAllAcademicRubrics(): Rubric[] {
  return listAcademicOccupations().map((o) => loadRubric(o.id));
}

export function flattenRubricSubjects(rubric: Rubric): RubricSubject[] {
  const out: RubricSubject[] = [];
  for (const tier of ["tier1", "tier2", "tier3"] as const) {
    for (const s of rubric.tiers[tier].subjects) {
      if (s.category === "catchAll" && s.name === "Others") continue;
      // Contextual catch-alls are informational only — never matched or scored.
      if (s.category === "contextual") continue;
      out.push({ ...s, tier });
    }
  }
  return out;
}

export function scoringSubjects(
  rubric: Rubric,
  tier: "tier1" | "tier2",
): RubricSubject[] {
  const want = tier === "tier1" ? "expected" : "core";
  return rubric.tiers[tier].subjects
    .filter((s) => s.category === want)
    .map((s) => ({ ...s, tier }));
}
