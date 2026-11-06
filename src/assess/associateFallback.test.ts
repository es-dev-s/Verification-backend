import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASSOCIATE_FALLBACK_THRESHOLD,
  associateFallbackFor,
  NEC_ANZSCO,
  NOT_SCORED_NOTE,
} from "./associateFallback.js";
import { assessExtractedSubjects } from "./assessCase.js";
import { listManualOccupationOptions } from "./manualOccupation.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import type { ExtractedSubjectRow, QualificationType } from "./schemas.js";

const entry = (anzscoCode: string, confidenceScore: number | null, missing: string[] = []) => ({
  anzscoCode,
  title: `Occupation ${anzscoCode}`,
  confidenceScore,
  determination: "no_match",
  missing,
});

describe("312999 fallback (pure decision)", () => {
  it("suggests 312999 when no specific Associate ANZSCO reaches 70%, with the near-miss list", () => {
    const fb = associateFallbackFor({
      associateOpen: true,
      ict60220: false,
      entries: [
        entry("312211", 55, ["CPCCBC4001 Apply building codes"]),
        entry("312511", 69, ["Computer-Aided Design (2D CAD)"]),
        entry("312511", 40),
      ],
    })!;
    assert.equal(fb.anzscoCode, NEC_ANZSCO);
    assert.equal(fb.threshold, ASSOCIATE_FALLBACK_THRESHOLD);
    assert.equal(fb.suggested, true);
    assert.deepEqual(
      fb.nearMisses.map((n) => [n.anzscoCode, n.confidenceScore]),
      [
        ["312511", 69],
        ["312211", 55],
        ["312311", null],
        ["312411", null],
      ],
    );
    assert.deepEqual(fb.nearMisses[0].missing, ["Computer-Aided Design (2D CAD)"]);
    assert.deepEqual(fb.nearMisses[1].missing, ["CPCCBC4001 Apply building codes"]);
    assert.deepEqual(fb.nearMisses[2].missing, [NOT_SCORED_NOTE]);
    assert.deepEqual(fb.nearMisses[3].missing, [NOT_SCORED_NOTE]);
    assert.match(fb.reason, /best 69%/);
  });

  it("any specific Associate score of 70% or more blocks 312999", () => {
    for (const score of [70, 85, 100]) {
      const fb = associateFallbackFor({
        associateOpen: true,
        ict60220: false,
        entries: [entry("312211", 20), entry("312311", score)],
      })!;
      assert.equal(fb.suggested, false, `score ${score}`);
      assert.match(fb.reason, /312311/);
    }
  });

  it("312411 (Electronics, now scored) counts toward the 70% rule; codes outside the Associate list do not", () => {
    const blocked = associateFallbackFor({
      associateOpen: true,
      ict60220: false,
      entries: [entry("312411", 95), entry("233512", 90), entry("312511", 30)],
    })!;
    assert.equal(blocked.suggested, false);
    assert.match(blocked.reason, /312411/);
    const fb = associateFallbackFor({
      associateOpen: true,
      ict60220: false,
      entries: [entry("312411", 60), entry("233512", 90), entry("312511", 30)],
    })!;
    assert.equal(fb.suggested, true);
    const elec = fb.nearMisses.find((n) => n.anzscoCode === "312411");
    assert.equal(elec?.confidenceScore, 60);
    assert.ok(!fb.nearMisses.some((n) => n.anzscoCode === "233512"));
  });

  it("ICT60220 holders never get 312999 (telecom codes are listed)", () => {
    const fb = associateFallbackFor({
      associateOpen: true,
      ict60220: true,
      entries: [entry("313213", 20), entry("312511", 10)],
    })!;
    assert.equal(fb.suggested, false);
    assert.match(fb.reason, /ICT60220/);
    assert.ok(fb.nearMisses.some((n) => n.anzscoCode === "313213"));
  });

  it("does not apply when the Engineering Associate track is not open", () => {
    assert.equal(associateFallbackFor({ associateOpen: false, ict60220: false, entries: [entry("312511", 10)] }), null);
  });
});

function row(name: string, qualification: QualificationType = "diploma", code: string | null = null): ExtractedSubjectRow {
  return { name, code, credits: null, grade: null, yearOrSemester: null, qualification, sourceSnippet: null, isRepeat: false };
}

/** Strong 312511 transcript (see mechDraftsperson.test.ts). */
const STRONG_DRAFTING = [
  "Applied Mathematics I",
  "Applied Physics",
  "Applied Chemistry",
  "Engineering Drawing I",
  "AutoCAD",
  "SolidWorks",
  "GD&T",
  "Machine Design I",
  "Manufacturing Technology I",
  "Engineering Materials",
  "Strength of Materials",
  "Hydraulics and Pneumatics",
  "Tool Design",
  "Drafting Project",
];
const engDiploma: QualificationInfo = {
  level: "diploma",
  title: "Diploma in Mechanical Engineering",
  countedYearsOverride: 2,
};

describe("312999 fallback (assessment result)", () => {
  it("engineering primary Diploma, nothing at 70%: 312999 suggested, never a scored candidate", () => {
    const res = assessExtractedSubjects(STRONG_DRAFTING.slice(0, 4).map((n) => row(n)), {
      qualifications: [engDiploma],
    });
    assert.equal(res.gate1?.result, "open");
    assert.equal(res.gate1?.rule, 5);
    const fb = res.associateFallback!;
    assert.equal(fb.suggested, true);
    const mech = fb.nearMisses.find((n) => n.anzscoCode === "312511")!;
    assert.ok(mech.confidenceScore != null && mech.confidenceScore < ASSOCIATE_FALLBACK_THRESHOLD);
    assert.ok(mech.missing.length > 0);
    assert.ok(!(res.candidates ?? []).some((c) => c.anzscoCode === NEC_ANZSCO));
    assert.notEqual(res.anzscoCode, NEC_ANZSCO);
  });

  it("a specific Associate code at 70% or more: 312999 not suggested", () => {
    const res = assessExtractedSubjects(STRONG_DRAFTING.map((n) => row(n)), { qualifications: [engDiploma] });
    const fb = res.associateFallback!;
    assert.equal(fb.suggested, false);
    assert.ok((fb.nearMisses.find((n) => n.anzscoCode === "312511")?.confidenceScore ?? 0) >= ASSOCIATE_FALLBACK_THRESHOLD);
  });

  it("ICT60220 holder: 312999 excluded", () => {
    const ict: QualificationInfo = {
      level: "advanced_diploma",
      title: "ICT60220 Advanced Diploma of Information Technology",
      countedYearsOverride: 2,
      engineeringShareOverride: 1,
    };
    const res = assessExtractedSubjects(
      [row("BSBCRT611 - Apply critical thinking for complex problem solving", "advanced_diploma", "BSBCRT611")],
      { qualifications: [ict] },
    );
    assert.equal(res.associateFallback?.suggested, false);
    assert.match(res.associateFallback!.reason, /ICT60220/);
  });

  it("no fallback when the Associate track is closed (4-year bachelor)", () => {
    const res = assessExtractedSubjects(STRONG_DRAFTING.map((n) => row(n, "bachelor")), {
      qualifications: [{ level: "bachelor", title: "Bachelor of Engineering (Mechanical)", countedYearsOverride: 4 }],
    });
    assert.equal(res.associateFallback ?? null, null);
  });

  it("the manual picker still lists 312999 as unavailable (no rubric)", () => {
    const nec = listManualOccupationOptions().find((o) => o.anzscoCode === NEC_ANZSCO);
    assert.ok(nec, "312999 is listed in the manual picker");
    assert.equal(nec.available, false);
  });
});