import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evidenceConfig } from "./evidenceConfig.js";
import { evaluateGate1 } from "./gate1.js";
import { decideLateralEntry, EMPTY_LATERAL_STATE } from "./lateralEntry.js";
import { listVocationalOccupations } from "./loadRubric.js";
import { countDuration, withTermIndex } from "./qualificationEvidence.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import type { ExtractedSubjectRow, Gate1Decision, Gate1TrackId, QualificationType } from "./schemas.js";
import { buildQualificationSummaries, TRANSCRIPT_FIELDS } from "./transcriptData.js";

const voc = listVocationalOccupations();

const ENG = [
  "Engineering Mathematics I",
  "Engineering Physics",
  "Engineering Mechanics",
  "Engineering Drawing",
  "Thermodynamics",
  "Fluid Mechanics",
  "Strength of Materials",
  "Machine Design",
  "Heat Transfer",
  "Manufacturing Processes",
  "Control Systems",
  "Final Year Project",
];

function sub(
  name: string,
  yearOrSemester: string | null,
  qualification: QualificationType = "bachelor",
  credits: string | null = "3",
): ExtractedSubjectRow {
  return { name, code: null, credits, grade: null, yearOrSemester, qualification, sourceSnippet: null, isRepeat: false };
}

/** ENG subjects spread over semesters 1..`semesters` (final project in the last one). */
const withSemesters = (semesters: number, level: QualificationType = "bachelor") =>
  ENG.map((n, i) => {
    const sem = n === "Final Year Project" ? semesters : Math.min(semesters, Math.floor((i * semesters) / (ENG.length - 1)) + 1);
    return sub(n, `Semester ${sem}`, level);
  }).map(withTermIndex);

/** ENG subjects with no period, `each` credits per subject (12 subjects). */
const noTerms = (each: string) => ENG.map((n) => sub(n, null, "bachelor", each));

const bachelor: QualificationInfo = { level: "bachelor", rawLevel: "bachelor", title: "Bachelor of Engineering in Mechanical Engineering" };
const advDip: QualificationInfo = { level: "advanced_diploma", rawLevel: "advanced_diploma", title: "Advanced Diploma of Engineering" };

const gate = (q: QualificationInfo, rows: ExtractedSubjectRow[]) => evaluateGate1({ qualifications: [q], rows, vocational: voc });
const track = (g: Gate1Decision, id: Gate1TrackId) => g.tracks.find((t) => t.track === id)!;
const fs = (field: string, finalValue: string | null) => ({ field, degreeLevel: "bachelor", extractedValue: null, finalValue });

describe("duration.roundHalfUp: a counted half year is rounded up", () => {
  it("is on by default", () => {
    assert.equal(evidenceConfig.duration.roundHalfUp, true);
  });

  it("7 semesters: 3.5 counted → 4 years, raw count kept in the method", () => {
    const c = countDuration(withSemesters(7));
    assert.equal(c.countedYears, 4);
    assert.equal(c.source, "terms");
    assert.match(c.method, /3\.5 years counted, rounded up to 4$/);
    assert.deepEqual(c.span, { unit: "semester", first: 1, last: 7 });
  });

  it("3.5 → 4 opens Professional Engineer under Gate 1 rule 3", () => {
    const g = gate(bachelor, withSemesters(7));
    assert.equal(g.result, "open");
    assert.equal(g.rule, 3);
    assert.equal(track(g, "professional_engineer").open, true);
  });

  it("5 semesters: 2.5 → 3 years (Gate 1 rule 4)", () => {
    assert.equal(countDuration(withSemesters(5)).countedYears, 3);
    const g = gate(bachelor, withSemesters(5));
    assert.equal(g.rule, 4);
    assert.equal(track(g, "professional_engineer").open, false);
    assert.equal(track(g, "engineering_technologist").open, true);
  });

  it("Advanced Diploma, 3 semesters: 1.5 → 2 years (rule 5)", () => {
    const rows = withSemesters(3, "advanced_diploma");
    assert.equal(countDuration(rows).countedYears, 2);
    const g = gate(advDip, rows);
    assert.equal(g.result, "open");
    assert.equal(g.rule, 5);
    assert.equal(track(g, "engineering_associate").open, true);
  });

  it("3 years / 4 years counted are unchanged (no rounding note)", () => {
    for (const [sems, years] of [[6, 3], [8, 4]] as const) {
      const c = countDuration(withSemesters(sems));
      assert.equal(c.countedYears, years);
      assert.doesNotMatch(c.method, /rounded up/);
    }
  });

  it("headings: 7 semester headings (one lost to OCR) → 4 years", () => {
    const text = ["I SEMESTER | I YEAR | II SEMESTER", "I SEMESTER | II YEAR | II SEMESTER", "I SEMESTER | III YEAR | II SEMESTER", "IV YEAR | II SEMESTER"].join("\n");
    const c = countDuration([sub("Engineering Mathematics", null), sub("Engineering Drawing", null)], { texts: [text] });
    assert.equal(c.countedYears, 4);
    assert.match(c.method, /^7 semester headings on the transcript; 3\.5 years counted, rounded up to 4$/);
  });

  it("credits: 148 credits (4.93) → existing half-year rounding (5), then unchanged", () => {
    const rows = ENG.slice(0, 4).map((n, i) => sub(n, null, "bachelor", String([37, 37, 37, 37][i])));
    const c = countDuration(rows);
    assert.equal(c.creditTotal, 148);
    assert.equal(c.source, "credits");
    assert.equal(c.countedYears, 5);
    assert.equal(c.creditConversion?.years, 5);
    assert.doesNotMatch(c.method, /rounded up/);
  });

  it("credits: 105 credits (3.5) → 4 years, conversion label unchanged", () => {
    const c = countDuration(noTerms("8.75"));
    assert.equal(c.creditTotal, 105);
    assert.equal(c.countedYears, 4);
    assert.equal(c.creditConversion?.years, 4);
    assert.equal(c.creditConversion?.label, "Converted from credits (105 credits ÷ 30 per year)");
    assert.match(c.method, /3\.5 years counted, rounded up to 4$/);
  });

  it("Stage 2 summary: counted 3.5 → 4 (tile shows 4 years; lateral entry sees 4)", () => {
    const [s] = buildQualificationSummaries([bachelor], withSemesters(7), []);
    assert.equal(s!.basis, "counted");
    assert.equal(s!.transcript.countedYears, 4);
    assert.equal(s!.effective.countedYears, 4);
    assert.equal(s!.durationCheck.message, "4 years, counted from the transcript.");
    const d = decideLateralEntry({
      durationYears: s!.effective.countedYears,
      startPeriod: null,
      credit: { rows: 0, noted: false },
      state: EMPTY_LATERAL_STATE,
      priorSubjectsRead: false,
    });
    assert.equal(d.route, 1);
  });

  it("an assessor-entered 3.5 is used as typed (not rounded): rule 4", () => {
    const [s] = buildQualificationSummaries([bachelor], withSemesters(8), [fs(TRANSCRIPT_FIELDS.countedYears, "3.5")]);
    assert.equal(s!.basis, "manual");
    assert.equal(s!.effective.countedYears, 3.5);
    assert.equal(s!.durationCheck.message, "3.5 years, entered by the assessor.");
    const g = gate({ ...bachelor, countedYearsOverride: 3.5 }, withSemesters(8));
    assert.equal(g.rule, 4);
    assert.equal(track(g, "professional_engineer").open, false);
  });

  it("flag off → the half year is kept", () => {
    const cfg = evidenceConfig.duration as { roundHalfUp: boolean };
    cfg.roundHalfUp = false;
    try {
      const c = countDuration(withSemesters(7));
      assert.equal(c.countedYears, 3.5);
      assert.doesNotMatch(c.method, /rounded up/);
    } finally {
      cfg.roundHalfUp = true;
    }
  });
});
