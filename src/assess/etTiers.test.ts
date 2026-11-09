import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessExtractedSubjects } from "./assessCase.js";
import { ET_GROUP_TIERS, etTierDetail } from "./etTiers.js";
import { adjustByFamily } from "./familyAdjust.js";
import { loadRubric } from "./loadRubric.js";
import type { ExtractedSubjectRow, SubjectMatch } from "./schemas.js";

function row(name: string): ExtractedSubjectRow {
  return {
    name,
    code: null,
    credits: null,
    grade: null,
    yearOrSemester: null,
    qualification: "bachelor",
    sourceSnippet: null,
    isRepeat: false,
  };
}
const m = (rubricSubject: string, tier: "tier1" | "tier2" | "tier3"): SubjectMatch => ({
  transcriptName: rubricSubject,
  transcriptCode: null,
  qualification: "bachelor",
  rubricSubject,
  tier,
  category: null,
  method: "exact",
  confidence: 1,
});

describe("ET 233914: sheet parts → rubric tiers", () => {
  it("maps partA → Tier 1, partB → Tier 2, partC → Tier 3", () => {
    assert.equal(ET_GROUP_TIERS.partA, "tier1");
    assert.equal(ET_GROUP_TIERS.partB_core, "tier2");
    assert.equal(ET_GROUP_TIERS.partB_optional, "tier2");
    assert.equal(ET_GROUP_TIERS.partC_core, "tier3");
    assert.equal(ET_GROUP_TIERS.partC_core_2, "tier3");
  });

  it("builds Tier 1 / 2 / 3 detail with sheet labels and matched rows", () => {
    const rubric = loadRubric("233914");
    const d = etTierDetail({
      rubric,
      scored: { foundationalMatched: 2, foundationalExpected: 5, coreMatched: 1, coreExpected: 7, tier3GateMet: true },
      matches: [
        m("Engineering Mathematics", "tier1"),
        m("Engineering Physics", "tier1"),
        m("Civil / Construction Technology", "tier2"),
        m("Final-Year / Capstone Project", "tier3"),
      ],
    });
    const [t1, t2, t3] = d.tiers;
    assert.equal(t1!.label, "Foundational Subjects");
    assert.equal(t1!.matched, 2);
    assert.equal(t1!.expected, 5);
    assert.ok(t1!.rows.some((r) => r.name === "Engineering Mathematics" && r.matched));
    assert.ok(t1!.rows.some((r) => r.optional));
    assert.equal(t2!.label, "Claimed Stream");
    assert.equal(t2!.matched, 1);
    assert.ok(t2!.rows.find((r) => r.name === "Civil / Construction Technology")?.matched);
    // The catch-all sentence row (no variants, unmatched) is not listed.
    assert.ok(!t2!.rows.some((r) => r.name.startsWith("All type of degree")));
    assert.equal(t3!.label, "Canonical project / capstone categories");
    assert.equal(t3!.expected, null);
    assert.equal(d.gateMet, true);
  });

  it("the Maybe Suitable entry carries the tiers and keeps max(own, formula)", () => {
    const tiers = etTierDetail({
      rubric: loadRubric("233914"),
      scored: { foundationalMatched: 0, foundationalExpected: 5, coreMatched: 0, coreExpected: 7, tier3GateMet: false },
      matches: [],
    });
    const r = adjustByFamily(
      { anzscoCode: "233211", title: "Civil Engineer", confidence: 75 },
      [],
      { etOwnConfidence: 80, etTiers: tiers },
    );
    assert.equal(r.maybeSuitable?.adjustedConfidence, 74);
    assert.equal(r.maybeSuitable?.capped, true);
    assert.equal(r.maybeSuitable?.tiers?.tiers.length, 3);
    const low = adjustByFamily({ anzscoCode: "233211", title: "Civil Engineer", confidence: 90 }, [], { etOwnConfidence: 50 });
    assert.equal(low.maybeSuitable?.adjustedConfidence, Math.max(50, low.maybeSuitable!.formulaConfidence));
    assert.equal(low.maybeSuitable?.tiers, undefined);
  });

  it("a PE assessment attaches ET's tier detail to the Maybe Suitable card", () => {
    const rows = [
      "Engineering Mathematics I",
      "Engineering Physics",
      "Engineering Chemistry",
      "Engineering Mechanics",
      "Engineering Drawing",
      "Structural Analysis",
      "Geotechnical Engineering",
      "Fluid Mechanics",
      "Hydraulics",
      "Transportation Engineering",
      "Surveying",
      "Reinforced Concrete Design",
      "Steel Structures Design",
      "Construction Management",
      "Environmental Engineering",
      "Water Supply Engineering",
      "Final Year Project",
    ].map(row);
    const res = assessExtractedSubjects(rows, {
      qualifications: [{ level: "bachelor", title: "Bachelor of Civil Engineering", countedYearsOverride: 4 }],
    });
    const ms = res.familyAdjustment?.maybeSuitable;
    assert.ok(ms, "ET offered as Maybe Suitable");
    assert.ok(ms!.tiers, "tiers on the ET card");
    assert.equal(ms!.tiers!.tiers[0]!.tier, "tier1");
    assert.ok(ms!.tiers!.tiers[0]!.matched >= 3);
  });
});
