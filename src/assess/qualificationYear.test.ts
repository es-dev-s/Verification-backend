import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessConfig } from "./config.js";
import { computeConfidenceScore } from "./score.js";
import {
  QUALIFICATION_YEAR_MISSING_NOTE,
  completionYearOf,
  parseCompletionYear,
  yearMultiplier,
} from "./qualificationYear.js";
import { assessExtractedSubjects } from "./assessCase.js";
import type { ExtractedSubjectRow } from "./schemas.js";

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

describe("parseCompletionYear", () => {
  it("reads graduation phrasing and session end years", () => {
    assert.equal(parseCompletionYear("Date of Graduation: May 2017"), 2017);
    assert.equal(parseCompletionYear("Session: 2013-2017"), 2017);
    assert.equal(parseCompletionYear("completed the programme on 1998"), 1998);
    assert.equal(parseCompletionYear("no dates here"), null);
  });
});

describe("yearMultiplier", () => {
  it("uses configurable cut-offs", () => {
    assert.equal(yearMultiplier(1999).factor, assessConfig.academicAlignment.yearMultiplierPre2000);
    assert.equal(yearMultiplier(2000).factor, assessConfig.academicAlignment.yearMultiplier2000To2010);
    assert.equal(yearMultiplier(2010).factor, assessConfig.academicAlignment.yearMultiplier2000To2010);
    assert.equal(yearMultiplier(2011).factor, 1);
    assert.equal(yearMultiplier(null).factor, 1);
  });
});

describe("computeConfidenceScore academic alignment", () => {
  const base = {
    rawDetermination: "verified_no_risk" as const,
    foundationalPct: 100,
    corePct: 100,
    tier3GateMet: true,
    workExperienceBoost: false,
    historicalPct: 100,
  };

  it("is 30/50/20 then capped at 96", () => {
    const score = computeConfidenceScore(base);
    assert.equal(score, assessConfig.academicAlignment.scoreCap);
  });

  it("halves a pre-2000 qualification then caps", () => {
    const score = computeConfidenceScore({ ...base, historicalPct: 0, completionYear: 1995 });
    // 0.3*100 + 0.5*100 + 0.2*0 = 80, × 0.5 = 40
    assert.equal(score, 40);
  });

  it("applies 0.7 for 2000–2010", () => {
    const score = computeConfidenceScore({ ...base, historicalPct: 0, completionYear: 2005 });
    assert.equal(score, 56);
  });

  it("does not apply a multiplier when the year is missing", () => {
    const withYear = computeConfidenceScore({ ...base, historicalPct: 0, completionYear: 2015 });
    const missing = computeConfidenceScore({ ...base, historicalPct: 0 });
    assert.equal(withYear, missing);
  });

  it("applies the +4 related-work boost before the 96% cap", () => {
    const cap = assessConfig.academicAlignment.scoreCap;
    const boosted = computeConfidenceScore({ ...base, workExperienceBoost: true });
    assert.equal(boosted, cap);
    const mid = computeConfidenceScore({
      ...base,
      foundationalPct: 50,
      corePct: 50,
      historicalPct: 50,
      workExperienceBoost: true,
    });
    assert.equal(mid, 54);
    assert.ok(mid <= cap);
  });
});

describe("qualification year on assessment", () => {
  const subjects = ["Engineering Mathematics I", "Engineering Physics", "Final Year Project"].map(row);

  it("flags when the year is missing", () => {
    const res = assessExtractedSubjects(subjects, {
      qualifications: [
        { level: "bachelor", title: "Bachelor of Engineering in Electrical Engineering", countedYearsOverride: 4 },
      ],
    });
    assert.equal(res.qualificationYearMissing, true);
    assert.equal(res.qualificationYear, null);
    assert.ok((res.qualificationNotes ?? []).includes(QUALIFICATION_YEAR_MISSING_NOTE));
    assert.equal(res.qualificationEvidence?.completionYearMissing, true);
  });

  it("records a stored completion year and does not flag", () => {
    const res = assessExtractedSubjects(subjects, {
      qualifications: [
        {
          level: "bachelor",
          title: "Bachelor of Engineering in Electrical Engineering",
          countedYearsOverride: 4,
          completionYear: 2018,
        },
      ],
    });
    assert.equal(res.qualificationYearMissing, false);
    assert.equal(res.qualificationYear, 2018);
    assert.ok(!(res.qualificationNotes ?? []).includes(QUALIFICATION_YEAR_MISSING_NOTE));
  });

  it("prefers the bachelor year when a master is also on file", () => {
    assert.equal(
      completionYearOf([
        { level: "master", title: "Master of Engineering", completionYear: 2020 },
        { level: "bachelor", title: "Bachelor of Engineering", completionYear: 2012 },
      ]).year,
      2012,
    );
  });
});
