import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countDuration, parseTerm, periodHeadingsOf, withTermIndex } from "./qualificationEvidence.js";
import type { ExtractedSubjectRow } from "./schemas.js";

function sub(name: string, yearOrSemester: string | null, credits: string | null = null, code: string | null = null): ExtractedSubjectRow {
  return {
    name,
    code,
    credits,
    grade: "B",
    yearOrSemester,
    qualification: "bachelor",
    sourceSnippet: null,
    isRepeat: false,
  };
}

/** Grade-sheet credits per semester for SE3–SE8 (148 in total). */
const SE_CREDITS: Array<[number, number[]]> = [
  [3, [3, 2, 4, 3, 2, 3, 2, 4, 3]],
  [4, [4, 3, 3, 3, 3, 3, 2, 2, 2]],
  [5, [3, 3, 3, 3, 2, 2, 2, 3, 3]],
  [6, [3, 3, 3, 3, 2, 2, 2, 3, 3]],
  [7, [3, 3, 3, 2, 2, 4, 3, 3, 3]],
  [8, [3, 6, 2, 3, 3, 3, 3]],
];

const seRows = (): ExtractedSubjectRow[] =>
  SE_CREDITS.flatMap(([sem, credits]) =>
    credits.map((c, i) => sub(`Civil Engineering Subject ${sem}-${i + 1}`, `SE${sem}`, String(c), `PCCE${sem}${i}0${i}`)),
  );

describe("SE<n> semester labels", () => {
  it("parseTerm: SE3 → semester 3, SE 8 → semester 8", () => {
    assert.equal(parseTerm("SE3")?.termIndex, 3);
    assert.equal(parseTerm("SE3")?.unit, "semester");
    assert.equal(parseTerm("SE 8")?.termIndex, 8);
    assert.equal(parseTerm("se16")?.termIndex, 16);
    assert.equal(parseTerm("Semester : SE3")?.termIndex, 3);
    assert.equal(parseTerm("SEM : SE5")?.termIndex, 5);
  });

  it("parseTerm: 'SE' alone, bare S3 and subject codes containing SE → null", () => {
    assert.equal(parseTerm("SE"), null);
    assert.equal(parseTerm("S3"), null);
    assert.equal(parseTerm("CSE301"), null);
    assert.equal(parseTerm("SE301"), null);
    assert.equal(parseTerm("BECS2212"), null);
    assert.equal(parseTerm("PCSE4203"), null);
    assert.equal(parseTerm("SE0"), null);
    assert.equal(parseTerm("SE17"), null);
  });

  it("existing labels unchanged", () => {
    assert.equal(parseTerm("Semester 5")?.termIndex, 5);
    assert.equal(parseTerm("Sem3")?.termIndex, 3);
    assert.equal(parseTerm("Y2S1")?.termIndex, 3);
    assert.equal(parseTerm("Seventh Semester")?.termIndex, 7);
  });

  it("rows SE3–SE8 with 148 credits → 3 years from the semesters, not the credits", () => {
    const rows = seRows();
    const c = countDuration(rows.map(withTermIndex));
    assert.equal(c.creditTotal, 148);
    assert.equal(c.countedYears, 3);
    assert.equal(c.source, "terms");
    assert.equal(c.creditConversion, null);
    assert.equal(c.confidence, "high");
    assert.deepEqual(c.span, { unit: "semester", first: 3, last: 8 });
    assert.equal(c.finalYear, 4);
  });

  it("rows SE1–SE8 → 4 years", () => {
    const rows = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [sub(`Subject ${n}a`, `SE${n}`, "3"), sub(`Subject ${n}b`, `SE ${n}`, "3")]);
    const c = countDuration(rows);
    assert.equal(c.countedYears, 4);
    assert.equal(c.source, "terms");
    assert.deepEqual(c.span, { unit: "semester", first: 1, last: 8 });
  });

  it("headings 'Semester : SE3' … 'SE8' → 6 headings, 3 years", () => {
    const text = [3, 4, 5, 6, 7, 8]
      .map((n, i) => `${i % 2 ? "Semester SE" : n === 7 ? "SEM : SE" : "Semester : SE"}${n}\nSub.Code: Subjects Registered | Credit Grade\nPCCE${n}201 SUBJECT ${n} | 3 B`)
      .join("\n");
    const h = periodHeadingsOf(text);
    assert.equal(h.length, 6);
    assert.deepEqual(h.map((x) => x.term.termIndex), [3, 4, 5, 6, 7, 8]);
    const c = countDuration([sub("Engineering Mathematics", null), sub("Engineering Drawing", null)], { texts: [text] });
    assert.equal(c.countedYears, 3);
    assert.equal(c.source, "terms");
  });

  it("an SGPA line naming SE3 is not a heading", () => {
    assert.equal(periodHeadingsOf("SGPA (SE3) :6.62 | SGPA(SE4) : 7.36\nCGPA(SE4) : 7.42").length, 0);
  });
});
