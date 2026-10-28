import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkSubjectIdLinks, flattenRubricSubjects, loadRubric } from "./loadRubric.js";
import { creditSharedOnce, matchSubjects } from "./matchSubjects.js";
import type { SubjectMatch } from "./schemas.js";

const here = dirname(fileURLToPath(import.meta.url));
const subjects = JSON.parse(readFileSync(resolve(here, "../lib/anzsco_subjects.json"), "utf8"));
const sheetRows = (occ: string) =>
  Object.values(subjects.find((e: any) => e.occupationId === occ).groups).flatMap((g: any) => g.subjects) as any[];
const heading = (occ: string, id: string) => {
  const r = loadRubric(occ);
  const raw = JSON.parse(readFileSync(resolve(here, "../lib/anzsco-verification-rubrics.json"), "utf8"))
    .occupations.find((o: any) => o.id === occ);
  const row = [
    ...(raw.tier1?.subjects ?? []), ...(raw.tier2?.core ?? []), ...(raw.tier2?.optional ?? []),
    ...(raw.tier3?.supporting ?? []), ...(raw.tier3?.optional ?? []),
  ].find((x: any) => x.id === id);
  const name = row ? row.name ?? row.label : raw.tier3.gate.label;
  return flattenRubricSubjects(r).find((s) => s.name === name)!;
};

describe("reviewed links (43 review-CSV rows)", () => {
  it("each reviewed rubric heading now has a subjects-file row", () => {
    const left = Object.fromEntries(checkSubjectIdLinks().map((r) => [r.occupationId, r.missingInSubjects]));
    assert.deepEqual(left["materials-engineer"], ["233112-T2.O3", "233112-T2.O7"]);
    assert.deepEqual(left["industrial-engineer"], [
      "233511-T2.4", "233511-T2.O1", "233511-T2.O3", "233511-T3.1", "233511-T3.O2",
    ]);
    for (const id of ["233513-T2.1", "233513-T2.4", "233513-T2.6", "233513-T2.O5", "233513-T2.O6", "233513-T2.O8", "233513-T3.G", "233513-T3.1", "233513-T3.O2"]) {
      assert.ok(!left["production-plant-engineer"]!.includes(id), id);
    }
  });

  it("a shared sheet row gives its variants to every linked rubric heading", () => {
    const row = sheetRows("materials-engineer").find((s) => s.name === "Materials Science / Physical Metallurgy");
    assert.equal(row.id, "233112-T2.1");
    assert.deepEqual(row.alsoIds, ["233112-T2.2", "233112-T2.O6"]);
    for (const id of ["233112-T2.1", "233112-T2.2", "233112-T2.O6"]) {
      const h = heading("materials-engineer", id);
      assert.equal(h.sharedVariantsFrom, "233112-T2.1", id);
      for (const v of row.variants) assert.ok(h.variants.includes(v), `${id}: ${v}`);
    }
    const adv = sheetRows("materials-engineer").find((s) => s.name === "Advanced & Functional Materials");
    assert.deepEqual([adv.id, ...adv.alsoIds], ["233112-T2.O1", "233112-T2.O2"]);
    assert.equal(heading("materials-engineer", "233112-T2.O2").sharedVariantsFrom, "233112-T2.O1");
  });

  it("the rubric tier and core/optional status win over the subjects-file group", () => {
    // Sheet rows sit in tier2_core / tier5_core / tier6_* groups; the rubric decides.
    assert.equal(heading("materials-engineer", "233112-T2.O4").category, "optional");
    assert.equal(heading("materials-engineer", "233112-T2.O4").tier, "tier2");
    assert.equal(heading("production-plant-engineer", "233513-T2.O6").tier, "tier2");
    assert.equal(heading("production-plant-engineer", "233513-T2.O6").category, "optional");
    assert.equal(heading("production-plant-engineer", "233513-T3.O2").category, "optional");
    const gate = heading("production-plant-engineer", "233513-T3.G");
    assert.equal(gate.tier, "tier3");
    assert.ok(gate.variants.length >= 13);
  });

  it("one transcript subject credits only one heading of a shared row", async () => {
    const subs = flattenRubricSubjects(loadRubric("materials-engineer"));
    const rows = ["Physical Metallurgy", "Engineering Materials", "Pyrometallurgy"].map((name) => ({
      name, qualification: "bachelor",
    }));
    const { matches } = await matchSubjects(rows as any, subs, { useLlm: false });
    const by = (n: string) => matches.filter((m) => m.transcriptName === n).map((m) => m.rubricSubject);
    assert.deepEqual(by("Physical Metallurgy"), ["Physical Metallurgy / Phase Transformations"]);
    // A second subject from the same sheet row takes a heading not yet credited.
    assert.deepEqual(by("Engineering Materials"), ["Materials Science / Structure of Materials / Crystallography"]);
    assert.deepEqual(by("Pyrometallurgy"), ["Extractive Metallurgy / Mineral Processing"]);
  });

  it("creditSharedOnce leaves non-shared hits alone", () => {
    const subs = [
      { name: "A", category: "core", variants: [], tier: "tier2", sharedVariantsFrom: "x" },
      { name: "B", category: "core", variants: [], tier: "tier2", sharedVariantsFrom: "x" },
      { name: "C", category: "core", variants: [], tier: "tier2" },
    ] as any;
    const m = (s: string, c = 1): SubjectMatch => ({
      transcriptName: "T", transcriptCode: null, qualification: "bachelor" as any,
      rubricSubject: s, tier: "tier2", category: "core", method: "exact", confidence: c,
    });
    const [kept] = creditSharedOnce([[m("A"), m("B", 0.9), m("C")]], subs);
    assert.deepEqual(kept!.map((x) => x.rubricSubject), ["A", "C"]);
  });
});
