import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countDuration } from "./qualificationEvidence.js";

/**
 * Anonymised lines from a two-column B.Tech transcript (odd semesters left,
 * even semesters right). Native text extraction merges both columns into one
 * line, so some headings land mid-line or glued to the text before them.
 */
const MERGED_TWO_COLUMN = [
  "Statement of marks of the examinations passed are given as under:",
  "SECOND Semester EDP No. 000000 April-2015",
  "Subject Name TP OM MM",
  "FIRST Semester EDP No. 000000",
  "Engineering Mathematics-I (BTAM-101) T 40 60",
  "TOTAL",
  "THIRD Semester EDP No. 000000",
  "TOTAL",
  "MM FOURTH Semester EDP No. 000000 Apr-2016",
  "Electrical Machines-I (BTEE-301) T 45 60",
  "TOTAL",
  "April-2018TPTTTT OM MM TOTALGeneral Fitness (GF5)Electric Power Utilization (BTEE-601)Subject NameSIXTH Semester EDP No. 000000 Nov-2017TPTTT OM MM",
  "FIFTH Semester EDP No. 000000",
  "Industrial Training(Undertaken after 4th semester) (BTEE-",
  "SEVENTH Semester EDP No. 000000",
  "MM TOTALEIGHTH Semester EDP No. 000000 April-2018",
  "Software Training T 80 100",
  "Industrial Project T 90 100",
  "TOTAL",
].join("\n");

describe("semester headings on merged two-column text", () => {
  it("finds all 8 semesters: 4 years, range 1-8", () => {
    const c = countDuration([], { texts: [MERGED_TWO_COLUMN] });
    assert.equal(c.countedYears, 4);
    assert.equal(c.finalYear, 4);
    assert.equal(c.unit, "semester");
    assert.deepEqual(c.span, { unit: "semester", first: 1, last: 8 });
    assert.match(c.method ?? "", /^8 semester headings/);
  });

  it("ignores 'after 4th semester' as a heading", () => {
    const text = [
      "FIRST Semester EDP No. 000000",
      "SECOND Semester EDP No. 000000",
      "Industrial Training(Undertaken after 4th semester)",
      "Project work completed before 6th semester, up to 7th semester, till 5th semester",
    ].join("\n");
    const c = countDuration([], { texts: [text] });
    assert.deepEqual(c.span, { unit: "semester", first: 1, last: 2 });
    assert.equal(c.countedYears, 1);
  });

  it("lateral entry: semesters 3-8 give 3 years, range 3-8", () => {
    const text = ["THIRD", "FOURTH", "FIFTH", "SIXTH", "SEVENTH", "EIGHTH"]
      .map((o) => `${o} Semester\nSubject A T 50 100\nTOTAL`)
      .join("\n");
    const c = countDuration([], { texts: [text] });
    assert.equal(c.countedYears, 3);
    assert.deepEqual(c.span, { unit: "semester", first: 3, last: 8 });
    assert.match(c.method ?? "", /semesters 3–8/);
  });

  it("glued all-caps ordinals and mid-line headings count", () => {
    const text = [
      "Subject NameFIRST Semester",
      "MM TOTALSECOND Semester",
      "Nov-2014\tTHIRD Semester EDP",
      "Marks Semester 4 Result",
    ].join("\n");
    const c = countDuration([], { texts: [text] });
    assert.deepEqual(c.span, { unit: "semester", first: 1, last: 4 });
    assert.equal(c.countedYears, 2);
  });

  it("does not take ordinary words ending in a numeral word as headings", () => {
    const text = ["Semester Project", "Semesters completed", "FIRST Semester", "SECOND Semester"].join("\n");
    const c = countDuration([], { texts: [text] });
    assert.deepEqual(c.span, { unit: "semester", first: 1, last: 2 });
  });

  it("a summary table repeating the semesters counts each once", () => {
    const sems = ["FIRST", "SECOND", "THIRD", "FOURTH", "FIFTH", "SIXTH"].map((o) => `${o} Semester\nTOTAL`);
    const summary = "Result summary: SGPA Semester 1 7.1 Semester 2 7.4 Semester 3 7.0";
    const c = countDuration([], { texts: [[...sems, summary].join("\n")] });
    assert.equal(c.countedYears, 3);
    assert.deepEqual(c.span, { unit: "semester", first: 1, last: 6 });
  });

  it("I / II restarting each year still counts every heading", () => {
    const text = ["I", "II", "I", "II", "I", "II"].map((r) => `Semester ${r}\nTOTAL`).join("\n");
    const c = countDuration([], { texts: [text] });
    assert.equal(c.countedYears, 3);
    assert.deepEqual(c.span, { unit: "semester", first: 1, last: 6 });
  });
});