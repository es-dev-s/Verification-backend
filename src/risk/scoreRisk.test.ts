import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildMissingMajorDomainsSentence,
  computeAlignmentScore,
  computeRiskScores,
  riskLevelFromScore,
  vocationalElectivePct,
} from "./scoreRisk.js";
import { RISK_SCORING_CONFIG } from "./riskBands.config.js";
import { buildRiskInsightFallback, withCompetence } from "./analyzeRisk.js";
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
  fundamentalPct: number,
  corePct: number,
  historical = hist(50, 80),
  workExperienceBoost = false,
) {
  return computeRiskScores({
    anzscoCode: "233111",
    title: "Chemical Engineer",
    fundamentalPct,
    corePct,
    historical,
    workExperienceBoost,
    missingCore: [],
  });
}

describe("governance config", () => {
  it("weights are 30 / 50 / 20 and sum to 1", () => {
    const w = RISK_SCORING_CONFIG.weights;
    assert.equal(w.fundamental, 0.3);
    assert.equal(w.core, 0.5);
    assert.equal(w.historical, 0.2);
    assert.equal(Math.round((w.fundamental + w.core + w.historical) * 1000), 1000);
  });

  it("bands are descending", () => {
    const b = RISK_SCORING_CONFIG.bands;
    assert.ok(b.noRisk > b.low && b.low > b.medium && b.medium > 0);
  });
});

describe("riskLevelFromScore", () => {
  it("maps the overall score with the config thresholds (boundaries inclusive)", () => {
    const b = RISK_SCORING_CONFIG.bands;
    assert.equal(riskLevelFromScore(b.noRisk), "no_risk");
    assert.equal(riskLevelFromScore(b.noRisk - 0.1), "low");
    assert.equal(riskLevelFromScore(b.low), "low");
    assert.equal(riskLevelFromScore(b.low - 0.1), "medium");
    assert.equal(riskLevelFromScore(b.medium), "medium");
    assert.equal(riskLevelFromScore(b.medium - 0.1), "high");
  });

  it("uses thresholds passed in (separate governance setting)", () => {
    const bands = { noRisk: 90, low: 70, medium: 40 };
    assert.equal(riskLevelFromScore(85, bands), "low");
    assert.equal(riskLevelFromScore(45, bands), "medium");
  });
});

describe("computeAlignmentScore", () => {
  it("Overall = 0.30 × Fundamental + 0.50 × Core + 0.20 × Historical", () => {
    const s = computeAlignmentScore({ fundamentalPct: 80, corePct: 70, historical: hist(50, 60) });
    // 24 + 35 + 12 = 71
    assert.equal(s.overallPct, 71);
    assert.equal(s.riskLevel, "medium");
    assert.equal(s.renormalised, false);
    assert.deepEqual(
      s.components.map((c) => [c.key, c.appliedWeight, c.used]),
      [
        ["fundamental", 0.3, true],
        ["core", 0.5, true],
        ["historical", 0.2, true],
      ],
    );
  });

  it("too few historical cases: historical left out, weights re-normalised, note added", () => {
    const min = RISK_SCORING_CONFIG.historicalMinCases;
    const s = computeAlignmentScore({ fundamentalPct: 80, corePct: 90, historical: hist(min - 1, 0) });
    // (0.3×80 + 0.5×90) / 0.8 = 86.25 → 86.3
    assert.equal(s.overallPct, 86.3);
    assert.equal(s.riskLevel, "no_risk");
    assert.equal(s.renormalised, true);
    const h = s.components.find((c) => c.key === "historical")!;
    assert.equal(h.used, false);
    assert.equal(h.appliedWeight, 0);
    assert.match(h.reason ?? "", /minimum/);
    assert.equal(s.components.find((c) => c.key === "fundamental")!.appliedWeight, 0.375);
    assert.equal(s.components.find((c) => c.key === "core")!.appliedWeight, 0.625);
    assert.ok(s.notes.some((n) => /re-normalised/.test(n)));
  });

  it("no historical cases: no neutral 50 — left out", () => {
    const s = computeAlignmentScore({ fundamentalPct: 60, corePct: 60, historical: hist(0, 50) });
    assert.equal(s.overallPct, 60);
    const h = s.components.find((c) => c.key === "historical")!;
    assert.equal(h.pct, null);
    assert.equal(h.used, false);
  });

  it("exactly the minimum cases counts", () => {
    const min = RISK_SCORING_CONFIG.historicalMinCases;
    const s = computeAlignmentScore({ fundamentalPct: 100, corePct: 100, historical: hist(min, 0) });
    assert.equal(s.overallPct, 80);
    assert.equal(s.renormalised, false);
  });
});

describe("computeRiskScores", () => {
  it("level comes from the weighted score", () => {
    const r = scoreWith(90, 90, hist(50, 80));
    // 27 + 45 + 16 = 88
    assert.equal(r.overallPct, 88);
    assert.equal(r.riskLevel, "no_risk");
    assert.equal(r.scoring?.overallPct, 88);
    assert.equal(r.riskBasis, undefined);
    assert.equal(r.scoring?.configVersion, RISK_SCORING_CONFIG.version);
  });

  it("weak core lowers the category", () => {
    const r = scoreWith(90, 40, hist(50, 80));
    // 27 + 20 + 16 = 63
    assert.equal(r.overallPct, 63);
    assert.equal(r.riskLevel, "medium");
  });

  it("work experience is a note only", () => {
    const a = scoreWith(70, 70, hist(50, 70), false);
    const b = scoreWith(70, 70, hist(50, 70), true);
    assert.equal(a.overallPct, b.overallPct);
    assert.equal(b.workExperienceDelta, 0);
    assert.ok(b.riskNotes?.some((n) => /work experience/i.test(n)));
  });

  it("vocational: core units + historical when electives are not assessed", () => {
    const r = computeRiskScores({
      anzscoCode: "312311",
      title: "Electrical Engineering Draftsperson",
      fundamentalPct: 0,
      corePct: 80,
      historical: hist(61, 70),
      workExperienceBoost: false,
      missingCore: [],
      assessmentFlow: "vocational_units",
      vocational: { electiveStatus: "not_assessed", electiveMinimum: null, electivesFound: [] },
    });
    // (0.5×80 + 0.2×70) / 0.7 = 77.14 → 77.1
    assert.equal(r.overallPct, 77.1);
    assert.equal(r.riskLevel, "low");
    const f = r.scoring!.components.find((c) => c.key === "fundamental")!;
    assert.equal(f.label, "Electives");
    assert.equal(f.used, false);
    assert.ok(!r.increasingRisk.some((l) => /foundational/.test(l)));
  });

  it("vocational: electives fill the fundamental slot when a minimum is set", () => {
    assert.equal(
      vocationalElectivePct({
        electiveStatus: "not_met",
        electiveMinimum: 4,
        electivesFound: [{ code: "A", name: "a" }],
      }),
      25,
    );
    assert.equal(
      vocationalElectivePct({
        electiveStatus: "met",
        electiveMinimum: 2,
        electivesFound: [
          { code: "A", name: "a" },
          { code: "B", name: "b" },
          { code: "C", name: "c" },
        ],
      }),
      100,
    );
    assert.equal(vocationalElectivePct(null), null);
  });
});

describe("competence", () => {
  it("fallback is competent only for No risk / Low", () => {
    const low = scoreWith(80, 80, hist(50, 70));
    const med = scoreWith(60, 60, hist(50, 60));
    assert.equal(low.riskLevel, "low");
    assert.equal(med.riskLevel, "medium");
    assert.equal(buildRiskInsightFallback(low).competent, true);
    assert.equal(buildRiskInsightFallback(med).competent, false);
  });

  it("conflict: category stands and a review note is added", () => {
    const med = scoreWith(60, 60, hist(50, 60));
    const r = withCompetence(med, { competent: true, insight: "x" });
    assert.equal(r.riskLevel, "medium");
    assert.equal(r.competence, "competent");
    assert.equal(r.competenceConflict, true);
    assert.ok(r.riskNotes?.some((n) => /assessor to review/.test(n)));
    const ok = withCompetence(med, { competent: false, insight: "x" });
    assert.equal(ok.competenceConflict, false);
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
