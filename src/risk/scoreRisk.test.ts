import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  baseRiskFromBands,
  buildMissingMajorDomainsSentence,
  computeRiskScores,
  historicalModifierApplies,
  riskLevelFromScore,
  worsenRiskLevel,
} from "./scoreRisk.js";
import { buildRiskInsightFallback, withCompetence } from "./analyzeRisk.js";
import { bandInputForCandidate } from "./bandInput.js";
import type { HistoricalStats } from "./schemas.js";

function hist(totalCases: number, positivePct: number): HistoricalStats {
  const positive = Math.round((totalCases * positivePct) / 100);
  return {
    totalCases,
    positive,
    negative: totalCases - positive,
    banned: 0,
    positivePct,
  };
}

function scoreWith(
  bands: Parameters<typeof computeRiskScores>[0]["bands"],
  historical = hist(0, 0),
  workExperienceBoost = false,
) {
  return computeRiskScores({
    anzscoCode: "233111",
    title: "Chemical Engineer",
    fundamentalPct: 70,
    corePct: 70,
    historical,
    workExperienceBoost,
    missingCore: [],
    bands,
  });
}

describe("riskLevelFromScore (legacy, display only)", () => {
  it("still maps the old alignment bands", () => {
    assert.equal(riskLevelFromScore(90), "no_risk");
    assert.equal(riskLevelFromScore(80), "low");
    assert.equal(riskLevelFromScore(60), "medium");
    assert.equal(riskLevelFromScore(40), "high");
  });
});

describe("baseRiskFromBands", () => {
  it("maps Step 3 determinations and bands to risk levels", () => {
    assert.equal(
      baseRiskFromBands({ determination: "verified_no_risk", tierOutcomes: ["no_risk", "no_risk"] }).level,
      "no_risk",
    );
    assert.equal(
      baseRiskFromBands({ determination: "verified_no_risk", tierOutcomes: ["no_risk", "low_risk"] }).level,
      "low",
    );
    assert.equal(
      baseRiskFromBands({ determination: "conditional", tierOutcomes: ["no_risk", "no_risk"] }).level,
      "medium",
    );
    assert.equal(
      baseRiskFromBands({ determination: "not_verified", tierOutcomes: ["high_risk", "high_risk"] }).level,
      "high",
    );
    assert.equal(baseRiskFromBands({ determination: "no_match", tierOutcomes: [] }).level, "high");
  });

  it("documents the caps in the basis", () => {
    const r = baseRiskFromBands({
      determination: "conditional",
      tierOutcomes: ["no_risk", "no_risk"],
      capReasons: ["major project / capstone gate not found"],
    });
    assert.match(r.basis, /Conditional/);
    assert.match(r.basis, /gate not found/);
  });
});

describe("computeRiskScores", () => {
  it("level comes from the bands, not the weighted %", () => {
    const r = scoreWith({ determination: "verified_no_risk", tierOutcomes: ["no_risk", "no_risk"] });
    assert.equal(r.riskLevel, "no_risk");
    assert.equal(r.baseRiskLevel, "no_risk");
    // 0.3*70 + 0.5*70 + 0.2*0 = 56 — display-only
    assert.equal(r.overallPct, 56);
    assert.equal(r.historicalModifierApplied, false);
  });

  it("historical modifier: ≥20 cases and <40% positive → one level worse with a note", () => {
    const r = scoreWith(
      { determination: "verified_no_risk", tierOutcomes: ["no_risk", "low_risk"] },
      hist(25, 30),
    );
    assert.equal(r.baseRiskLevel, "low");
    assert.equal(r.riskLevel, "medium");
    assert.equal(r.historicalModifierApplied, true);
    assert.ok(r.riskNotes?.some((n) => /one level worse/.test(n)));
  });

  it("historical stats below the case floor or ≥40% are context only", () => {
    assert.equal(historicalModifierApplies(hist(19, 10)), false);
    assert.equal(historicalModifierApplies(hist(30, 40)), false);
    assert.equal(historicalModifierApplies(hist(20, 39)), true);
    const r = scoreWith({ determination: "conditional", tierOutcomes: [] }, hist(10, 10));
    assert.equal(r.riskLevel, "medium");
    assert.ok(r.riskNotes?.some((n) => /context only/.test(n)));
    assert.equal(worsenRiskLevel("high"), "high");
  });

  it("work experience is a note only", () => {
    const r = scoreWith(
      { determination: "conditional", tierOutcomes: ["no_risk", "medium_risk"] },
      hist(0, 0),
      true,
    );
    assert.equal(r.riskLevel, "medium");
    assert.equal(r.workExperienceDelta, 0);
    assert.equal(r.overallPct, r.overallPctBeforeWork);
    assert.ok(r.riskNotes?.some((n) => /work experience/i.test(n)));
  });
});

describe("competence", () => {
  it("fallback is competent only for No risk / Low", () => {
    const low = scoreWith({ determination: "verified_no_risk", tierOutcomes: ["low_risk"] });
    const med = scoreWith({ determination: "conditional", tierOutcomes: [] });
    assert.equal(buildRiskInsightFallback(low).competent, true);
    assert.equal(buildRiskInsightFallback(med).competent, false);
  });

  it("conflict: band stands and a review note is added", () => {
    const med = scoreWith({ determination: "conditional", tierOutcomes: [] });
    const r = withCompetence(med, { competent: true, insight: "x" });
    assert.equal(r.riskLevel, "medium");
    assert.equal(r.competence, "competent");
    assert.equal(r.competenceConflict, true);
    assert.ok(r.riskNotes?.some((n) => /assessor to review/.test(n)));
    const ok = withCompetence(med, { competent: false, insight: "x" });
    assert.equal(ok.competenceConflict, false);
  });
});

describe("bandInputForCandidate", () => {
  it("uses saved band fields and cap reasons", () => {
    const b = bandInputForCandidate({
      anzscoCode: "233111",
      determination: "no_match",
      bandDetermination: "conditional",
      tier1Outcome: "no_risk",
      tier2Outcome: "low_risk",
      tier3GateMet: false,
      gateDowngraded: true,
    });
    assert.equal(b.determination, "conditional");
    assert.deepEqual(b.tierOutcomes, ["no_risk", "low_risk"]);
    assert.ok(b.capReasons?.some((c) => /gate/.test(c)));
  });

  it("vocational: the core-unit band decides", () => {
    const b = bandInputForCandidate({
      anzscoCode: "312311",
      bandDetermination: "verified_no_risk",
      assessmentFlow: "vocational_units",
      tier1Outcome: null,
      tier2Outcome: "low_risk",
    });
    assert.deepEqual(b.tierOutcomes, ["low_risk"]);
    assert.equal(baseRiskFromBands(b).level, "low");
  });

  it("old saved results: bands re-derived from counts and rubric thresholds", () => {
    const b = bandInputForCandidate({
      anzscoCode: "233111",
      determination: "verified_no_risk",
      foundationalMatched: 99,
      coreMatched: 99,
    });
    assert.equal(b.determination, "verified_no_risk");
    assert.deepEqual(b.tierOutcomes, ["no_risk", "no_risk"]);
  });
});

describe("buildMissingMajorDomainsSentence", () => {
  it("returns a single sentence", () => {
    assert.equal(
      buildMissingMajorDomainsSentence([]),
      "No major core domains are missing for this occupation.",
    );
    assert.equal(
      buildMissingMajorDomainsSentence(["Heat Transfer"]),
      "Missing major domain: Heat Transfer.",
    );
  });
});
