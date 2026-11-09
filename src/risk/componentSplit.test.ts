import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadRubric, scoringSubjects } from "../assess/loadRubric.js";
import { academicRubricFor, riskComponentSplits, splitTier } from "./componentSplit.js";
import { computeRiskScores } from "./scoreRisk.js";
import { profileSimilarity, withSimilarCases, type PastCase } from "./similarCases.js";
import type { HistoricalStats } from "./schemas.js";

describe("risk: 70% Major / 30% Supporting", () => {
  it("uses the rubric's Supporting marking (263311)", () => {
    const rubric = academicRubricFor("263311")!;
    const counted = scoringSubjects(rubric, "tier2");
    const supporting = counted.filter((s) => s.weight === "supporting");
    assert.equal(supporting.length, 2);
    const major = counted.filter((s) => s.weight !== "supporting");
    const all = new Set(major.map((s) => s.name));
    const split = splitTier(rubric, "tier2", all, { pct: 0, matched: major.length });
    assert.equal(split.method, "rubric");
    assert.equal(split.majorPct, 100);
    assert.equal(split.supportingPct, 0);
    assert.equal(split.pct, 70);
    assert.equal(split.missingSupporting.length, 2);
    assert.deepEqual(split.missingMajor, []);
    // 6 Major / 2 Supporting: one Major row is 70/6 ≈ 11.7 points, one Supporting row 30/2 = 15.
    const lessMajor = new Set([...major.slice(1), ...supporting].map((s) => s.name));
    const lessSupp = new Set([...major, ...supporting.slice(1)].map((s) => s.name));
    const a = splitTier(rubric, "tier2", lessMajor, { pct: 0, matched: counted.length - 1 });
    const b = splitTier(rubric, "tier2", lessSupp, { pct: 0, matched: counted.length - 1 });
    assert.equal(a.pct, 88.3);
    assert.equal(b.pct, 85);
  });

  it("marks soft-core rows of 233411 as Supporting", () => {
    const rubric = loadRubric("233411");
    const names = scoringSubjects(rubric, "tier2").filter((s) => s.weight === "supporting").map((s) => s.name);
    assert.deepEqual(names, ["Power Electronics", "Instrumentation & Measurement"]);
  });

  it("derives Supporting from Optional rows and never lowers the score", () => {
    const rubric = loadRubric("233211");
    const counted = scoringSubjects(rubric, "tier2");
    const half = counted.slice(0, 4).map((s) => s.name);
    const plain = { pct: (4 / counted.length) * 100, matched: 4 };
    const without = splitTier(rubric, "tier2", new Set(half), plain);
    assert.equal(without.method, "derived");
    assert.equal(without.pct, Math.round(plain.pct * 10) / 10);
    const optional = rubric.tiers.tier2.subjects.filter((s) => s.category === "optional").map((s) => s.name);
    const withOpt = splitTier(rubric, "tier2", new Set([...half, ...optional]), plain);
    assert.equal(withOpt.supportingPct, 100);
    assert.ok(withOpt.pct > without.pct);
    assert.equal(withOpt.pct, Math.round((0.7 * plain.pct + 30) * 10) / 10);
  });

  it("falls back to the plain % when the names do not add up, or with no rubric", () => {
    const rubric = academicRubricFor("263311")!;
    const s = splitTier(rubric, "tier2", new Set(), { pct: 50, matched: 3 });
    assert.equal(s.method, "plain");
    assert.equal(s.pct, 50);
    const none = riskComponentSplits({ rubric: null, matches: [], fundamental: { pct: 80, matched: 4 }, core: { pct: 60, matched: 3 } });
    assert.equal(none.core.pct, 60);
    assert.equal(none.fundamental.method, "plain");
  });

  it("feeds the split score into the overall risk and lists Major gaps only", () => {
    const rubric = academicRubricFor("263311")!;
    const counted = scoringSubjects(rubric, "tier2");
    const major = counted.filter((s) => s.weight !== "supporting");
    const matches = major.map((s) => ({ rubricSubject: s.name, tier: "tier2" as const, method: "exact" as const }));
    const splits = riskComponentSplits({
      rubric,
      matches,
      fundamental: { pct: 100, matched: 5 },
      core: { pct: (major.length / counted.length) * 100, matched: major.length },
    });
    const hist: HistoricalStats = { totalCases: 0, positive: 0, negative: 0, banned: 0, positivePct: 50 };
    const r = computeRiskScores({
      anzscoCode: "263311",
      title: rubric.title,
      fundamentalPct: 100,
      corePct: 0,
      historical: hist,
      workExperienceBoost: false,
      missingCore: counted.filter((s) => s.weight === "supporting").map((s) => s.name),
      splits,
    });
    assert.equal(r.corePct, 70);
    assert.ok(r.componentSplits);
    assert.match(r.missingMajorDomains, /No major core domains are missing/);
    assert.ok(r.increasingRisk.some((l) => /supporting core/.test(l)));
  });
});

describe("risk: similarity to past cases", () => {
  const base: HistoricalStats = { totalCases: 10, positive: 5, negative: 5, banned: 0, positivePct: 50 };
  const past = (title: string, uni: string, country: string, outcome: string): PastCase => ({
    occupation: { anzscoCode: "233211" },
    qualifications: { bachelor: { title, university: uni, country } },
    outcome,
  });
  const applicant = { degreeTitle: "Bachelor of Civil Engineering", university: "Alpha University", country: "Nepal" };

  it("scores similarity from degree title, university and country", () => {
    assert.equal(profileSimilarity(applicant, { ...applicant }), 1);
    assert.equal(profileSimilarity(applicant, { degreeTitle: "Bachelor of Civil Engineering", university: null, country: null }), 0.5);
    assert.equal(profileSimilarity(applicant, { degreeTitle: "Diploma in Nursing", university: "Beta College", country: "Nepal" }), 0.2);
  });

  it("weights similar outcomes, blended with all past cases", () => {
    const cases = [
      past("Bachelor of Civil Engineering", "Alpha University", "Nepal", "Positive"),
      past("Bachelor of Civil Engineering", "Gamma Institute", "Nepal", "Positive"),
      past("Diploma in Nursing", "Beta College", "India", "Negative"),
      { ...past("Bachelor of Civil Engineering", "Alpha University", "Nepal", "Negative"), occupation: { anzscoCode: "233914" } },
    ];
    const h = withSimilarCases(base, "233211", applicant, cases);
    assert.equal(h.similar?.cases, 2);
    assert.equal(h.similar?.positive, 2);
    assert.equal(h.similar?.weightedPositivePct, 100);
    // (1.0×100 + 0.7×100 + 5×50) / (1.7 + 5)
    assert.equal(h.scorePct, Math.round(((170 + 250) / 6.7) * 10) / 10);
    assert.equal(h.positivePct, 50);
  });

  it("keeps the plain ANZSCO rate with no similar case, and no past cases stays unused", () => {
    const h = withSimilarCases(base, "233211", applicant, [past("Diploma in Nursing", "Beta College", "India", "Negative")]);
    assert.equal(h.scorePct, 50);
    assert.equal(h.similar?.cases, 0);
    const none = withSimilarCases({ ...base, totalCases: 0 }, "233211", applicant, []);
    assert.equal(none.scorePct, undefined);
  });

  it("the Historical component uses the similarity score with the 20% weight", () => {
    const h = { ...base, scorePct: 80 };
    const r = computeRiskScores({
      anzscoCode: "233211",
      title: "Civil Engineer",
      fundamentalPct: 100,
      corePct: 100,
      historical: h,
      workExperienceBoost: false,
      missingCore: [],
    });
    const hc = r.scoring!.components.find((c) => c.key === "historical")!;
    assert.equal(hc.pct, 80);
    assert.equal(hc.weight, 0.2);
    assert.equal(r.overallPct, 96);
    assert.equal(r.historicalPct, 80);
  });
});
