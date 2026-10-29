import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessExtractedSubjects, scoreRoutedOccupations } from "./assessCase.js";
import {
  countDuration,
  decideEngineering,
  durationBasisFor,
  NOT_ENGINEERING_NOTE,
  parseTerm,
  preferFinalYearGate,
  PROJECT_NOT_FINAL_YEAR_NOTE,
  withTermIndex,
} from "./qualificationEvidence.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import {
  subjectExtractLlmSchema,
  subjectNameToExtractedRow,
  type ExtractedSubjectRow,
  type SubjectMatch,
} from "./schemas.js";

function sub(
  name: string,
  yearOrSemester: string | null = null,
  qualification: ExtractedSubjectRow["qualification"] = "bachelor",
  credits: string | null = null,
): ExtractedSubjectRow {
  return {
    name,
    code: null,
    credits,
    grade: null,
    yearOrSemester,
    qualification,
    sourceSnippet: name,
    isRepeat: false,
  };
}

const CHEM = [
  "Engineering Mathematics - I",
  "Engineering Physics",
  "Engineering Chemistry",
  "Engineering Mechanics",
  "Engineering Drawing",
  "Material and Energy Balances",
  "Chemical Engineering Thermodynamics",
  "Fluid Mechanics",
  "Heat Transfer",
  "Mass Transfer I",
  "Chemical Reaction Engineering",
  "Plant Design & Economics",
  "Process Dynamics and Control",
  "Engineering Economy",
  "Industrial Training",
  "Final Year Project",
];

/** Spread the CHEM subjects over `semesters` semesters (project in the last one). */
function chemWithSemesters(semesters: number): ExtractedSubjectRow[] {
  return CHEM.map((n, i) => {
    const sem =
      n === "Final Year Project" ? semesters : Math.min(semesters, Math.floor((i * semesters) / (CHEM.length - 1)) + 1);
    return sub(n, `Year ${Math.ceil(sem / 2)} Semester ${sem % 2 === 0 ? 2 : 1}`, "bachelor", "3");
  });
}

const chemQual = (durationYears: number | null): QualificationInfo => ({
  level: "bachelor",
  title: "Bachelor of Engineering (Chemical)",
  durationYears,
});

describe("A. extraction: credits and year / semester", () => {
  it("LLM schema accepts credits / yearOrSemester and the row keeps them as strings", () => {
    const parsed = subjectExtractLlmSchema.parse({
      subjects: [
        { name: "Heat Transfer", code: null, credits: 3, yearOrSemester: "Year 3 Semester 2" },
        { name: "Fluid Mechanics", code: null },
      ],
    });
    const [a, b] = parsed.subjects.map((s) =>
      subjectNameToExtractedRow(s.name, s.code ?? null, {
        credits: s.credits ?? null,
        yearOrSemester: s.yearOrSemester ?? null,
      }),
    );
    assert.equal(a!.credits, "3");
    assert.equal(a!.yearOrSemester, "Year 3 Semester 2");
    assert.equal(b!.credits, null);
    assert.equal(b!.yearOrSemester, null);
    assert.equal(withTermIndex(a!).termIndex, 6);
    assert.equal(withTermIndex(a!).termUnit, "semester");
  });

  it("parses common term labels into a sortable index", () => {
    assert.equal(parseTerm("Year 3 Sem 2")?.termIndex, 6);
    assert.equal(parseTerm("Y3S2")?.termIndex, 6);
    assert.equal(parseTerm("Semester V")?.termIndex, 5);
    assert.equal(parseTerm("Eighth Semester")?.termIndex, 8);
    assert.equal(parseTerm("3rd Year")?.unit, "year");
    assert.equal(parseTerm("3rd Year")?.termIndex, 3);
    assert.equal(parseTerm("Level 200")?.termIndex, 2);
    assert.equal(parseTerm("Trimester 2")?.unit, "trimester");
    assert.equal(parseTerm("Fall 2019")?.academicYear, 2019);
    assert.equal(parseTerm("Spring 2020")?.academicYear, 2019);
    assert.equal(parseTerm("Semester 1, 2019")?.unit, "calendar");
    assert.equal(parseTerm(null), null);
    assert.equal(parseTerm("Elective"), null);
  });
});

describe("B. counted duration / Gate 1", () => {
  it("counts 4 years from 8 semesters (high confidence)", () => {
    const c = countDuration(chemWithSemesters(8));
    assert.equal(c.countedYears, 4);
    assert.equal(c.confidence, "high");
    assert.equal(c.creditTotal, 48);
    assert.equal(c.finalYear, 4);
  });

  it("does not count when too few rows show a term", () => {
    const rows = CHEM.map((n, i) => sub(n, i < 2 ? "Semester 1" : null));
    const c = countDuration(rows);
    assert.equal(c.countedYears, null);
    assert.equal(c.confidence, "low");
  });

  it("duration basis carries counted and stated years for Gate 1", () => {
    const [b] = durationBasisFor(chemWithSemesters(6), [chemQual(4)]);
    assert.equal(b!.count.countedYears, 3);
    assert.equal(b!.statedYears, 4);
  });

  it("Gate 1 opens Professional Engineer when counted matches stated (4 years)", () => {
    const full = assessExtractedSubjects(chemWithSemesters(8), { qualifications: [chemQual(4)] });
    assert.equal(full.gate1?.result, "open");
    assert.equal(full.gate1?.rule, 3);
    assert.equal(full.gate1?.durationFallback, false);
    assert.equal(full.anzscoCode, "233111");
  });

  it("Gate 1 sends a counted 3 years vs stated 4 to manual review (no scores)", () => {
    const short = assessExtractedSubjects(chemWithSemesters(6), { qualifications: [chemQual(4)] });
    assert.equal(short.gate1?.result, "manual_review");
    assert.equal(short.gate1?.rule, 2);
    assert.match(short.gate1?.reason ?? "", /differ/i);
    assert.deepEqual(short.candidates, []);
    assert.equal(short.confidenceScore, 0);
    assert.equal(short.explanation, short.gate1?.reason);
  });

  it("saved rows without terms fall back to the stated duration with a flag", () => {
    const plain = CHEM.map((n) => sub(n));
    const res = assessExtractedSubjects(plain, { qualifications: [chemQual(4)] });
    assert.equal(res.gate1?.result, "open");
    assert.equal(res.gate1?.durationFallback, true);
    assert.ok(res.gate1?.fallbackNote);
    assert.equal(res.anzscoCode, "233111");
    assert.deepEqual(res.qualificationEvidence?.duration, []);
    assert.ok(!(res.candidates?.[0]?.qualificationNotes ?? []).some((n) => n.startsWith("Duration")));
  });
});

describe("C. final-year project", () => {
  const gateName = "Major Project / Thesis / Final-Year Project/ Capstone Project";
  const gm = (name: string): SubjectMatch => ({
    transcriptName: name,
    transcriptCode: null,
    qualification: "bachelor",
    rubricSubject: gateName,
    tier: "tier3",
    category: "core",
    method: "exact",
    confidence: 1,
  });

  it("prefers the final-year project over an early-year one", () => {
    const rows = [...chemWithSemesters(8).filter((r) => r.name !== "Final Year Project"),
      sub("Mini Project", "Year 2 Semester 1"),
      sub("Capstone Design Project", "Year 4 Semester 2")];
    const r = preferFinalYearGate([gm("Mini Project"), gm("Capstone Design Project")], rows, gateName);
    assert.equal(r.matches[0]!.transcriptName, "Capstone Design Project");
    assert.equal(r.finalProject?.inFinalYear, true);
    assert.equal(r.finalProject?.note, null);
  });

  it("notes a project that is only in an early year (no cap)", () => {
    const rows = [...chemWithSemesters(8).filter((r) => r.name !== "Final Year Project"),
      sub("Mini Project", "Year 2 Semester 1")];
    const r = preferFinalYearGate([gm("Mini Project")], rows, gateName);
    assert.equal(r.finalProject?.inFinalYear, false);
    assert.equal(r.finalProject?.note, PROJECT_NOT_FINAL_YEAR_NOTE);
  });

  it("keeps current behaviour without term info", () => {
    const rows = [sub("Mini Project"), sub("Thesis")];
    const matches = [gm("Mini Project"), gm("Thesis")];
    const r = preferFinalYearGate(matches, rows, gateName);
    assert.deepEqual(r.matches, matches);
    assert.equal(r.finalProject?.title, "Mini Project");
    assert.equal(r.finalProject?.inFinalYear, null);
  });

  it("stores the final project title on the result", () => {
    const res = assessExtractedSubjects(chemWithSemesters(8), { qualifications: [chemQual(4)] });
    assert.equal(res.finalProjectTitle, "Final Year Project");
    assert.equal(res.qualificationEvidence?.finalProject?.inFinalYear, true);
  });
});

describe("D. engineering decision", () => {
  const business = [
    "Principles of Accounting", "Business Law", "Marketing Management", "Microeconomics",
    "Organisational Behaviour", "Business Statistics", "Human Resource Management",
    "Corporate Finance", "Business Communication", "Strategic Management",
  ].map((n) => sub(n));

  it("yes for an engineering title", () => {
    const d = decideEngineering({ qualifications: [chemQual(4)], rows: CHEM.map((n) => sub(n)) });
    assert.equal(d.decision, "yes");
    assert.equal(d.capped, false);
  });

  it("no for a non-engineering title with weak subject evidence", () => {
    const d = decideEngineering({
      qualifications: [{ level: "bachelor", title: "Bachelor of Business Administration" }],
      rows: business,
    });
    assert.equal(d.decision, "no");
    assert.equal(d.capped, false);
    assert.equal(d.note, NOT_ENGINEERING_NOTE);
  });

  it("unclear for a non-engineering title with engineering subjects", () => {
    const d = decideEngineering({
      qualifications: [{ level: "bachelor", title: "Bachelor of Science" }],
      rows: CHEM.map((n) => sub(n)),
    });
    assert.equal(d.decision, "unclear");
    assert.equal(d.capped, false);
  });

  it("Step 2 engineering-titled tick means yes", () => {
    const d = decideEngineering({
      qualifications: [{ level: "bachelor", title: "Bachelor of Business Administration" }],
      rows: business,
      engineeringTitledDegree: true,
    });
    assert.equal(d.decision, "yes");
  });

  it("a clear no is not eligible at Gate 1: nothing is scored", () => {
    const rows = [...business, ...CHEM.slice(0, 1).map((n) => sub(n))];
    const quals: QualificationInfo[] = [
      { level: "bachelor", title: "Bachelor of Business Administration", durationYears: 4 },
    ];
    const { scored, gate } = scoreRoutedOccupations(rows, { workExperienceBoost: false, qualifications: quals });
    assert.equal(gate.result, "not_eligible");
    assert.equal(gate.rule, 1);
    assert.equal(scored.length, 0);
    assert.ok(gate.tracks.every((t) => !t.open && t.reason));
    const res = assessExtractedSubjects(rows, { qualifications: quals });
    assert.equal(res.gate1?.result, "not_eligible");
    assert.deepEqual(res.candidates, []);
  });
});
