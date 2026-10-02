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
    }),
  }),
});

export type Rubric = z.infer<typeof rubricSchema>;
export type RubricSubject = z.infer<typeof subjectSchema> & {
  tier: "tier1" | "tier2" | "tier3";
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, "../lib");

let cached: Rubric | null = null;

/** Load and validate dataFlow.json (primary scoring rubric). */
export function loadRubric(anzscoCode = "233111"): Rubric {
  if (cached && cached.anzscoCode === anzscoCode) return cached;
  const path = resolve(libDir, "dataFlow.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const parsed = rubricSchema.parse(raw);
  if (parsed.anzscoCode !== anzscoCode) {
    throw new Error(
      `Rubric ANZSCO ${parsed.anzscoCode} does not match requested ${anzscoCode}`,
    );
  }
  cached = mergeExtraVariants(parsed);
  return cached;
}

/**
 * Merge naming variants from subjects.json (sheet dump) into the rubric
 * so matching has the fullest synonym list without hardcoding names.
 */
function mergeExtraVariants(rubric: Rubric): Rubric {
  try {
    const path = resolve(libDir, "subjects.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      groups?: Record<string, { subjects?: Array<{ name: string; variants?: string[] }> }>;
    };
    const byName = new Map<string, Set<string>>();
    for (const group of Object.values(raw.groups ?? {})) {
      for (const s of group.subjects ?? []) {
        const key = s.name.replace(/\s*\(Optional\)\s*$/i, "").trim();
        if (!byName.has(key)) byName.set(key, new Set());
        for (const v of s.variants ?? []) {
          const t = v.trim();
          if (t) byName.get(key)!.add(t);
        }
      }
    }
    const mergeTier = (subjects: Rubric["tiers"]["tier1"]["subjects"]) =>
      subjects.map((s) => {
        const extra = byName.get(s.name);
        if (!extra?.size) return s;
        const set = new Set([...s.variants, ...extra]);
        return { ...s, variants: [...set] };
      });

    return {
      ...rubric,
      tiers: {
        tier1: {
          ...rubric.tiers.tier1,
          subjects: mergeTier(rubric.tiers.tier1.subjects),
        },
        tier2: {
          ...rubric.tiers.tier2,
          subjects: mergeTier(rubric.tiers.tier2.subjects),
        },
        tier3: {
          ...rubric.tiers.tier3,
          subjects: mergeTier(rubric.tiers.tier3.subjects),
        },
      },
    };
  } catch {
    return rubric;
  }
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
