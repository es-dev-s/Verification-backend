import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildMissingMajorDomainsSentence,
  computeAlignmentScore,
  computeRiskScores,
  riskLevelFromScore,
  withCurrentScoring,
} from "./scoreRisk.js";
import { RISK_SCORING_CONFIG } from "./riskBands.config.js";
import { buildRiskInsightFallback, withCompetence } from "./analyzeRisk.js";
import type { HistoricalStats, RiskAssessmentResult } from "./schemas.js";

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

  it("a single past case counts (no minimum): historical used at full weight", () => {
    const s = computeAlignmentScore({ fundamentalPct: 80, corePct: 90, historical: hist(1, 0) });
    // 0.3×80 + 0.5×90 + 0.2×0 = 69
    assert.equal(s.overallPct, 69);
    assert.equal(s.renormalised, false);
    const h = s.components.find((c) => c.key === "historical")!;
    assert.equal(h.used, true);
    assert.equal(h.pct, 0);
    assert.equal(h.appliedWeight, 0.2);
    assert.equal(h.reason, undefined);
    assert.equal("historicalMinCases" in s, false);
    assert.equal("historicalMinCases" in RISK_SCORING_CONFIG, false);
  });

  it("few past cases (3, 2 positive) use the datasheet positive %", () => {
    const s = computeAlignmentScore({ fundamentalPct: 100, corePct: 100, historical: hist(3, 66.7) });
    // 30 + 50 + 0.2×66.7 = 93.34 → 93.3
    assert.equal(s.overallPct, 93.3);
    assert.equal(s.components.find((c) => c.key === "historical")!.used, true);
  });

  it("no historical cases: no neutral 50 — left out, weights re-normalised 37.5 / 62.5", () => {
    const s = computeAlignmentScore({ fundamentalPct: 80, corePct: 90, historical: hist(0, 50) });
    // (0.3×80 + 0.5×90) / 0.8 = 86.25 → 86.3
    assert.equal(s.overallPct, 86.3);
    assert.equal(s.riskLevel, "no_risk");
    assert.equal(s.renormalised, true);
    const h = s.components.find((c) => c.key === "historical")!;
    assert.equal(h.pct, null);
    assert.equal(h.used, false);
    assert.equal(h.appliedWeight, 0);
    assert.match(h.reason ?? "", /No past cases/);
    assert.equal(s.components.find((c) => c.key === "fundamental")!.appliedWeight, 0.375);
    assert.equal(s.components.find((c) => c.key === "core")!.appliedWeight, 0.625);
    assert.ok(s.notes.some((n) => /re-normalised/.test(n)));
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
    assert.equal("workExperienceDelta" in b, false);
    assert.equal("overallPctBeforeWork" in b, false);
    assert.ok(b.riskNotes?.some((n) => /work experience/i.test(n)));
  });

    it("vocational AU Civil/Electrical: foundationalPct feeds Fundamental; electives ignored", () => {
    const withElectives = {
      electiveStatus: "met" as const,
      electiveMinimum: 4,
      electivesFound: [
        { code: "E1", name: "elective one" },
        { code: "E2", name: "elective two" },
        { code: "E3", name: "elective three" },
        { code: "E4", name: "elective four" },
      ],
    };
    const r = computeRiskScores({
      anzscoCode: "312211",
      title: "Civil Engineering Draftsperson",
      fundamentalPct: 80,
      corePct: 70,
      historical: hist(50, 60),
      workExperienceBoost: false,
      missingCore: [],
      assessmentFlow: "vocational_units",
      vocational: withElectives,
    });
    // 0.3*80 + 0.5*70 + 0.2*60 = 24 + 35 + 12 = 71
    assert.equal(r.overallPct, 71);
    assert.equal(r.riskLevel, "medium");
    const f = r.scoring!.components.find((c) => c.key === "fundamental")!;
    assert.equal(f.label, "Foundational units");
    assert.equal(f.used, true);
    assert.equal(f.pct, 80);
    const core = r.scoring!.components.find((c) => c.key === "core")!;
    assert.equal(core.label, "Core units");
    assert.equal(r.componentSplits, undefined);
    // Same score when electives are not_assessed / empty: electives do not affect risk.
    const r2 = computeRiskScores({
      anzscoCode: "312311",
      title: "Electrical Engineering Draftsperson",
      fundamentalPct: 80,
      corePct: 70,
      historical: hist(50, 60),
      workExperienceBoost: false,
      missingCore: [],
      assessmentFlow: "vocational_units",
      vocational: { electiveStatus: "not_assessed", electiveMinimum: null, electivesFound: [] },
    });
    assert.equal(r2.overallPct, r.overallPct);
    assert.equal(r2.scoring!.components.find((c) => c.key === "fundamental")!.pct, 80);
  });

  it("vocational: missing foundationalPct drops Fundamental and re-normalises", () => {
    const r = computeRiskScores({
      anzscoCode: "312311",
      title: "Electrical Engineering Draftsperson",
      fundamentalPct: null,
      corePct: 80,
      historical: hist(61, 70),
      workExperienceBoost: false,
      missingCore: [],
      assessmentFlow: "vocational_units",
      vocational: { electiveStatus: "met", electiveMinimum: 2, electivesFound: [{ code: "A", name: "a" }, { code: "B", name: "b" }] },
    });
    // (0.5*80 + 0.2*70) / 0.7 = 77.14 -> 77.1
    assert.equal(r.overallPct, 77.1);
    assert.equal(r.riskLevel, "low");
    const f = r.scoring!.components.find((c) => c.key === "fundamental")!;
    assert.equal(f.label, "Foundational units");
    assert.equal(f.used, false);
    assert.equal(f.pct, null);
    assert.ok(r.scoring!.renormalised);
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

describe("withCurrentScoring (saved results shown with the current bands)", () => {
  const full = (r: ReturnType<typeof scoreWith>): RiskAssessmentResult => ({
    ...r,
    competence: "competent",
    competenceSource: "ai",
    insight: "x",
  });

  it("current results are returned unchanged", () => {
    const r = full(scoreWith(90, 90, hist(50, 80)));
    const v = withCurrentScoring(r);
    assert.equal(v.overallPct, r.overallPct);
    assert.equal(v.riskLevel, r.riskLevel);
    assert.equal(v.scoring?.configVersion, RISK_SCORING_CONFIG.version);
  });

  it("older band-based result: re-scored with the weights and config bands, band fields and work points dropped", () => {
    const r = full(scoreWith(80, 90, hist(3, 100)));
    const legacy = {
      ...r,
      scoring: undefined,
      riskLevel: "high" as const,
      overallPct: 40,
      riskBasis: "Step 3 determination: not verified",
      historicalModifierApplied: true,
      overallPctBeforeWork: 36,
      workExperienceDelta: 4,
    } as RiskAssessmentResult;
    const v = withCurrentScoring(legacy);
    // 0.3×80 + 0.5×90 + 0.2×100 = 89
    assert.equal(v.overallPct, 89);
    assert.equal(v.riskLevel, riskLevelFromScore(89, RISK_SCORING_CONFIG.bands));
    assert.deepEqual(v.scoring?.bands, RISK_SCORING_CONFIG.bands);
    assert.equal(v.riskBasis, undefined);
    assert.equal(v.historicalModifierApplied, undefined);
    assert.equal("workExperienceDelta" in v, false);
    assert.equal("overallPctBeforeWork" in v, false);
  });

  it("result saved under the old minimum-cases rule now counts the few past cases", () => {
    const r = full(scoreWith(80, 90, hist(3, 100)));
    const old = {
      ...r,
      overallPct: 86.3,
      scoring: {
        ...r.scoring!,
        configVersion: "2026-10-29-default",
        overallPct: 86.3,
        historicalMinCases: 10,
      },
      riskNotes: ["Historical outcomes not used: Only 3 past cases (minimum 10).", "Weights re-normalised: x.", "Keep me."],
    } as RiskAssessmentResult;
    const v = withCurrentScoring(old);
    assert.equal(v.overallPct, 89);
    assert.equal(v.scoring?.renormalised, false);
    assert.deepEqual(v.riskNotes, ["Keep me."]);
  });

  it("vocational with null foundational keeps the fundamental slot empty when re-scored", () => {
    const r = full(
      computeRiskScores({
        anzscoCode: "312311",
        title: "Electrical Engineering Draftsperson",
        fundamentalPct: null,
        corePct: 80,
        historical: hist(0, 0),
        workExperienceBoost: false,
        missingCore: [],
        assessmentFlow: "vocational_units",
        vocational: null,
      }),
    );
    const v = withCurrentScoring({ ...r, scoring: { ...r.scoring!, configVersion: "old" } });
    assert.equal(v.overallPct, 80);
    assert.equal(v.scoring?.components.find((c) => c.key === "fundamental")?.used, false);
    assert.equal(v.scoring?.components.find((c) => c.key === "fundamental")?.label, "Foundational units");
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
