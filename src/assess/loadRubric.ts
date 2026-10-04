import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const subjectSchema = z.object({
  name: z.string(),
  category: z.string(),
  variants: z.array(z.string()).default([]),
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

type NamedSubject = { name?: string; label?: string; status?: string; aliases?: string[] };
type OccupationRaw = {
  id: string;
  anzsco: string;
  title: string;
  flow: string;
  qualification?: { statement?: string };
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
    gate?: { label?: string; aliases?: string[] };
    supporting?: NamedSubject[];
    optional?: NamedSubject[];
    onGateMissing?: string;
  };
  source?: { version?: string };
};

type FlowRaw = {
  determinationRules?: Array<{
    when: { tier1?: string[]; tier2?: string[] };
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
  groups?: Record<
    string,
    { subjects?: Array<{ name: string; variants?: string[] }> }
  >;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, "../lib");

let rubricsFile: RubricsFile | null = null;
let subjectsFile: SubjectsEntry[] | null = null;
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

function stripOptionalSuffix(name: string): string {
  return name.replace(/\s*\(Optional\)\s*$/i, "").trim();
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

function variantsIndexForOccupation(
  occupation: OccupationRaw,
): Map<string, Set<string>> {
  const entries = loadSubjectsFile();
  const match =
    entries.find(
      (e) =>
        e.anzscoCode != null &&
        String(e.anzscoCode) === String(occupation.anzsco) &&
        titlesRoughlyEqual(e.title, occupation.title),
    ) ??
    entries.find(
      (e) =>
        e.anzscoCode != null &&
        String(e.anzscoCode) === String(occupation.anzsco),
    ) ??
    entries.find((e) => titlesRoughlyEqual(e.title, occupation.title));

  const byName = new Map<string, Set<string>>();
  if (!match?.groups) return byName;

  for (const group of Object.values(match.groups)) {
    for (const s of group.subjects ?? []) {
      const key = stripOptionalSuffix(s.name);
      if (!key || /^others$/i.test(key)) continue;
      if (!byName.has(key)) byName.set(key, new Set());
      for (const v of s.variants ?? []) {
        const t = v.trim();
        if (t) byName.get(key)!.add(t);
      }
    }
  }
  return byName;
}

function titlesRoughlyEqual(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[/()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const na = norm(a);
  const nb = norm(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

function withVariants(
  name: string,
  category: string,
  byName: Map<string, Set<string>>,
  extra: string[] = [],
): z.infer<typeof subjectSchema> {
  const set = new Set<string>(extra);
  const fromFile = byName.get(stripOptionalSuffix(name));
  if (fromFile) for (const v of fromFile) set.add(v);
  // Also try loose key match (punctuation differences)
  if (!fromFile) {
    for (const [key, vals] of byName) {
      if (titlesRoughlyEqual(key, name)) {
        for (const v of vals) set.add(v);
        break;
      }
    }
  }
  return { name, category, variants: [...set] };
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

  const byName = variantsIndexForOccupation(occupation);
  const defaults = file.defaults?.outcomes;

  const tier1Subjects = (occupation.tier1.subjects ?? []).map((s) => {
    const name = subjectName(s);
    const status = (s.status ?? "expected").toLowerCase();
    const category =
      status === "optional" || status === "elective" ? "optional" : "expected";
    return withVariants(name, category, byName, s.aliases ?? []);
  });

  const tier2Subjects = [
    ...(occupation.tier2.core ?? []).map((s) =>
      withVariants(subjectName(s), "core", byName, s.aliases ?? []),
    ),
    ...(occupation.tier2.optional ?? []).map((s) =>
      withVariants(subjectName(s), "optional", byName, s.aliases ?? []),
    ),
  ];

  const gateLabel =
    occupation.tier3?.gate?.label ??
    "Major Project / Thesis / Final-Year Project/ Capstone Project";
  const gateAliases = occupation.tier3?.gate?.aliases ?? [];

  const tier3Subjects = [
    withVariants(gateLabel, "core", byName, gateAliases),
    ...(occupation.tier3?.supporting ?? []).map((s) =>
      withVariants(subjectName(s), "core", byName, s.aliases ?? []),
    ),
    ...(occupation.tier3?.optional ?? []).map((s) =>
      withVariants(subjectName(s), "optional", byName, s.aliases ?? []),
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
        }
      : undefined,
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

/** Compile rubrics for every academic occupation. */
export function loadAllAcademicRubrics(): Rubric[] {
  return listAcademicOccupations().map((o) => loadRubric(o.id));
}

export function flattenRubricSubjects(rubric: Rubric): RubricSubject[] {
  const out: RubricSubject[] = [];
  for (const tier of ["tier1", "tier2", "tier3"] as const) {
    for (const s of rubric.tiers[tier].subjects) {
      if (s.category === "catchAll" && s.name === "Others") continue;
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
