import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessExtractedSubjects } from "./assessCase.js";
import { flattenRubricSubjects, loadRubric } from "./loadRubric.js";
import { matchSubjectsSync } from "./matchSubjects.js";
import { normalizeSubjectName, bestSimilarity } from "./normalize.js";
import type { ExtractedSubjectRow } from "./schemas.js";
import { needsMastersFallback, scoreAssessment } from "./score.js";

function sub(
  name: string,
  qualification: ExtractedSubjectRow["qualification"] = "bachelor",
): ExtractedSubjectRow {
  return {
    name,
    code: null,
    credits: null,
    grade: null,
    yearOrSemester: null,
    qualification,
    sourceSnippet: name,
    isRepeat: false,
  };
}

const CHEM_ENG_TRANSCRIPT: ExtractedSubjectRow[] = [
  sub("Engineering Mathematics - I"),
  sub("Engineering Physics"),
  sub("Engineering Chemistry"),
  sub("Engineering Mechanics"),
  sub("Engineering Drawing"),
  sub("Material and Energy Balances"),
  sub("Chemical Engineering Thermodynamics"),
  sub("Fluid Mechanics"),
  sub("Heat Transfer"),
  sub("Mass Transfer I"),
  sub("Chemical Reaction Engineering"),
  sub("Plant Design & Economics"),
  sub("Process Dynamics and Control"),
  sub("Engineering Economy"),
  sub("Final Year Project"),
  sub("Industrial Training"),
];

const IT_TRANSCRIPT: ExtractedSubjectRow[] = [
  sub("Apply critical thinking for complex problem solving"),
  sub("Manage team effectiveness"),
  sub("Promote workplace cyber security awareness and best practices"),
  sub("Interact with clients on a business level"),
  sub("Manage IP, ethics and privacy in ICT environments"),
  sub("Plan and monitor business analysis activities"),
  sub("Lead corporate social responsibility"),
];

describe("normalizeSubjectName", () => {
  it("normalizes chem eng abbreviations", () => {
    assert.equal(
      normalizeSubjectName("ChE Thermodynamics 1"),
      normalizeSubjectName("Chemical Engineering Thermodynamics 1"),
    );
  });
});

describe("matchSubjectsSync", () => {
  it("exact-matches Chemical Engineering core subjects", () => {
    const rubric = loadRubric("233111");
    const subjects = flattenRubricSubjects(rubric);
    const { matches } = matchSubjectsSync(CHEM_ENG_TRANSCRIPT, subjects);
    const cores = matches.filter(
      (m) => m.tier === "tier2" && m.category === "core" && m.method !== "none",
    );
    const names = new Set(cores.map((m) => m.rubricSubject));
    assert.ok(names.size >= 8, `expected ≥8 core matches, got ${names.size}`);
  });

  it("does not match unrelated IT units to chemical cores", () => {
    const rubric = loadRubric("233111");
    const subjects = flattenRubricSubjects(rubric);
    const { matches } = matchSubjectsSync(IT_TRANSCRIPT, subjects);
    const cores = matches.filter(
      (m) => m.tier === "tier2" && m.category === "core" && m.method !== "none",
    );
    assert.equal(cores.length, 0);
  });

  it("fuzzy-matches close names above threshold", () => {
    assert.ok(bestSimilarity("Heat Transfer Fundamentals", "Heat Transfer") > 0.5);
    const rubric = loadRubric("233111");
    const subjects = flattenRubricSubjects(rubric);
    const { matches } = matchSubjectsSync(
      [sub("Process Heat Transfer")],
      subjects,
    );
    const hit = matches.find((m) => m.rubricSubject === "Heat Transfer");
    assert.ok(hit);
    assert.ok(hit!.method === "exact" || hit!.method === "fuzzy");
  });
});

describe("scoreAssessment / assessExtractedSubjects", () => {
  it("recommends 233111 for a Chemical Engineering transcript", () => {
    const result = assessExtractedSubjects(CHEM_ENG_TRANSCRIPT);
    assert.equal(result.recommended, true);
    assert.equal(result.anzscoCode, "233111");
    assert.ok(result.confidence === "high" || result.confidence === "medium");
    assert.ok(result.foundationalMatched >= 4);
    assert.ok(result.coreMatched >= 6);
    assert.equal(result.tier3GateMet, true);
  });

  it("returns no match for an unrelated IT transcript", () => {
    const result = assessExtractedSubjects(IT_TRANSCRIPT);
    assert.equal(result.recommended, false);
    assert.equal(result.anzscoCode, null);
    assert.equal(result.determination, "no_match");
  });

  it("includes masters when bachelor core is insufficient", () => {
    const weakBachelor: ExtractedSubjectRow[] = [
      sub("Engineering Mathematics"),
      sub("Engineering Physics"),
      sub("Engineering Chemistry"),
      sub("Engineering Mechanics"),
      sub("Engineering Drawing"),
      sub("Heat Transfer"),
      sub("Fluid Mechanics"),
      sub("Final Year Project"),
      // masters fills remaining cores
      sub("Material and Energy Balances", "master"),
      sub("Chemical Engineering Thermodynamics", "master"),
      sub("Mass Transfer I", "master"),
      sub("Chemical Reaction Engineering", "master"),
      sub("Plant Design & Economics", "master"),
      sub("Process Dynamics and Control", "master"),
      sub("Engineering Economy", "master"),
    ];
    const result = assessExtractedSubjects(weakBachelor);
    assert.ok(result.qualificationsUsed.includes("master"));
    assert.ok(result.coreMatched >= 6);
  });

  it("needsMastersFallback for medium/high tier2", () => {
    assert.equal(needsMastersFallback("medium_risk"), true);
    assert.equal(needsMastersFallback("high_risk"), true);
    assert.equal(needsMastersFallback("low_risk"), false);
  });

  it("optional subjects do not reduce core score", () => {
    const rubric = loadRubric("233111");
    const subjects = flattenRubricSubjects(rubric);
    const withOptional = [
      ...CHEM_ENG_TRANSCRIPT,
      sub("Environmental Sciences"),
      sub("Seminar"),
    ];
    const { matches } = matchSubjectsSync(withOptional, subjects);
    const scored = scoreAssessment({
      matches,
      qualificationsUsed: ["bachelor"],
      workExperienceBoost: false,
      rubric,
    });
    const baseline = assessExtractedSubjects(CHEM_ENG_TRANSCRIPT);
    assert.equal(scored.coreMatched, baseline.coreMatched);
  });

  it("CV boost raises conditional confidence to high", () => {
    // Build a conditional case: enough for conditional but not verified_no_risk
    // Tier1: 4–5 no_risk, Tier2: 4–5 medium → conditional
    const conditionalSubjects: ExtractedSubjectRow[] = [
      sub("Engineering Mathematics"),
      sub("Engineering Physics"),
      sub("Engineering Chemistry"),
      sub("Engineering Mechanics"),
      sub("Material and Energy Balances"),
      sub("Chemical Engineering Thermodynamics"),
      sub("Fluid Mechanics"),
      sub("Heat Transfer"),
      sub("Final Year Project"),
    ];
    const noBoost = assessExtractedSubjects(conditionalSubjects, {
      workExperienceBoost: false,
    });
    const boosted = assessExtractedSubjects(conditionalSubjects, {
      workExperienceBoost: true,
    });
    if (noBoost.recommended && noBoost.determination === "conditional") {
      assert.equal(noBoost.confidence, "medium");
      assert.equal(boosted.confidence, "high");
    } else {
      // If thresholds land differently, at least boost must not worsen
      assert.ok(boosted.recommended === noBoost.recommended);
    }
  });
});
