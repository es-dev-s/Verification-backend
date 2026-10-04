import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildMissingMajorDomainsSentence,
  computeRiskScores,
  riskLevelFromScore,
  WORK_EXPERIENCE_DELTA,
} from "./scoreRisk.js";

describe("riskLevelFromScore", () => {
  it("maps alignment bands to risk levels", () => {
    assert.equal(riskLevelFromScore(90), "no_risk");
    assert.equal(riskLevelFromScore(80), "low");
    assert.equal(riskLevelFromScore(60), "medium");
    assert.equal(riskLevelFromScore(40), "high");
  });
});

describe("computeRiskScores", () => {
  it("weights fundamental 30 / core 50 / historical 20 and applies work boost", () => {
    const base = computeRiskScores({
      anzscoCode: "233111",
      title: "Chemical Engineer",
      fundamentalPct: 100,
      corePct: 100,
      historical: {
        totalCases: 10,
        positive: 8,
        negative: 2,
        banned: 0,
        positivePct: 80,
      },
      workExperienceBoost: false,
      missingCore: [],
    });
    // 0.3*100 + 0.5*100 + 0.2*80 = 96
    assert.equal(base.overallPct, 96);
    assert.equal(base.riskLevel, "no_risk");

    const boosted = computeRiskScores({
      anzscoCode: "233111",
      title: "Chemical Engineer",
      fundamentalPct: 70,
      corePct: 70,
      historical: {
        totalCases: 4,
        positive: 2,
        negative: 2,
        banned: 0,
        positivePct: 50,
      },
      workExperienceBoost: true,
      missingCore: ["Heat Transfer"],
    });
    // 0.3*70 + 0.5*70 + 0.2*50 = 66, +5 work = 71
    assert.equal(boosted.overallPctBeforeWork, 66);
    assert.equal(boosted.workExperienceDelta, WORK_EXPERIENCE_DELTA);
    assert.equal(boosted.overallPct, 71);
    assert.equal(boosted.riskLevel, "medium");
    assert.ok(
      boosted.reducingRisk.some((r) => /work experience/i.test(r)),
    );
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
