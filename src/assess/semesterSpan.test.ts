import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateGate1 } from "./gate1.js";
import { admissionNoteOf, contradictionOf, decideLateralEntry, EMPTY_LATERAL_STATE, startPeriodOf } from "./lateralEntry.js";
import { listVocationalOccupations } from "./loadRubric.js";
import {
  applyTextPeriods,
  countDuration,
  isReliableCount,
  parseTerm,
  periodHeadingsOf,
  withTermIndex,
} from "./qualificationEvidence.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import type { ExtractedSubjectRow } from "./schemas.js";
import { buildQualificationSummaries, lateralEntryForCase } from "./transcriptData.js";

const voc = listVocationalOccupations();

function sub(name: string, yearOrSemester: string | null = null, code: string | null = null, documentId?: string): ExtractedSubjectRow {
  return {
    name,
    code,
    credits: null,
    grade: "BB",
    yearOrSemester,
    qualification: "bachelor",
    sourceSnippet: null,
    isRepeat: false,
    ...(documentId ? { documentId } : {}),
  };
}

/** Synthetic GTU-style D2D transcript: SEM 3–8 headings, exam-session codes per row, two-column lines. */
const GTU_SUBJECTS: Array<[string, string, number, string]> = [
  ["3130001", "Engineering Graphics Lab", 3, "W2019"],
  ["3130002", "Complex Variables And Partial Differential Equations", 3, "W2019"],
  ["3131901", "Kinematics And Theory Of Machines", 3, "W2019"],
  ["3141901", "Fluid Mechanics And Hydraulic Machines", 4, "S2020"],
  ["3141902", "Manufacturing Processes", 4, "S2020"],
  ["3151901", "Heat Transfer", 5, "W2020"],
  ["3151902", "Design Of Machine Elements", 5, "W2020"],
  ["3161901", "Dynamics Of Machinery", 6, "S2021"],
  ["3161902", "Computer Aided Design", 6, "S2021"],
  ["3171901", "Refrigeration And Air Conditioning", 7, "W2021"],
  ["3171902", "Summer Internship", 7, "W2021"],
  ["3181901", "Industrial Engineering", 8, "S2022"],
  ["3181902", "Project Phase II", 8, "S2022"],
];
function gtuText(): string {
  const lines = [
    "GUJARAT TECHNOLOGICAL UNIVERSITY",
    "STATEMENT OF GRADES",
    "BRANCH : MECHANICAL ENGINEERING",
    "ADMISSION TYPE : D2D",
    "C2D : admission at 2nd year (3rd semester) in degree course after diploma",
  ];
  for (let sem = 3; sem <= 8; sem++) {
    const heading = sem % 2 ? `SEM :${sem} | HRS/WEEK` : `SEM : ${sem} TRIAL : 1 SPI : 7.45`;
    lines.push(heading);
    if (sem % 2) lines.push("TRIAL : 1 | SPI : 7.2");
    const here = GTU_SUBJECTS.filter((s) => s[2] === sem);
    // Two columns on one line when there are two subjects.
    lines.push(here.map(([code, name, , session]) => `${code} ${name.toUpperCase()} 3 0 2 4 BB ${session}`).join("   |   "));
  }
  return lines.join("\n");
}
const gtuRows = () => GTU_SUBJECTS.map(([code, name, , session]) => sub(name, session, code, "t1"));

const bachelor = (texts: string[] = []): QualificationInfo => ({
  level: "bachelor",
  rawLevel: "bachelor",
  title: "Bachelor of Engineering (Mechanical)",
  texts,
});

describe("semester headings", () => {
  const variants: Array<[string, string]> = [
    ["SEM : 3", "semester 3"],
    ["SEM:3", "semester 3"],
    ["Sem-3", "semester 3"],
    ["Sem 3", "semester 3"],
    ["Semester III", "semester 3"],
    ["SEMESTER - V", "semester 5"],
    ["3rd Semester", "semester 3"],
    ["Third Semester", "semester 3"],
    ["Year 2 Semester 1", "semester 3"],
    ["SEM : 3 TRIAL : 2 SPI : 3.61", "semester 3"],
    ["SEM :7 | TRIAL:1", "semester 7"],
  ];
  for (const [heading, label] of variants) {
    it(`reads "${heading}"`, () => {
      assert.equal(parseTerm(heading)?.label, label);
      const h = periodHeadingsOf(`Code Subject\n${heading}\n3130001 Some Subject`);
      assert.equal(h.length, 1, heading);
      assert.equal(h[0]!.term.label, label);
    });
  }

  it("a subject title or an exam session is not a heading", () => {
    assert.equal(periodHeadingsOf("Year 1 Studio Design 3 0 AA").length, 0);
    assert.equal(periodHeadingsOf("Semester Project 4 AA").length, 0);
    assert.equal(parseTerm("S2020"), null);
    assert.equal(parseTerm("W2019"), null);
  });
});

describe("duration counts the span studied", () => {
  it("GTU-style transcript (SEM 3–8, exam sessions per row) → 3 years", () => {
    const raw = gtuRows();
    // Before: exam-session labels give no term, so nothing is counted from periods.
    assert.equal(isReliableCount(countDuration(raw)), false);
    const rows = applyTextPeriods(raw, [{ id: "t1", text: gtuText() }]).map(withTermIndex);
    assert.ok(rows.every((r) => parseTerm(r.yearOrSemester)?.unit === "semester"), "every row placed under its heading");
    assert.equal(rows.find((r) => r.code === "3171902")!.yearOrSemester, "SEM :7");
    const c = countDuration(rows);
    assert.equal(c.source, "terms");
    assert.equal(c.countedYears, 3);
    assert.equal(c.finalYear, 4);
    assert.match(c.method, /semesters 3–8/);
    assert.equal(startPeriodOf(rows)?.index, 3);
  });

  it("GTU-style transcript asks the lateral-entry question; a No is re-confirmed", () => {
    const text = gtuText();
    const rows = applyTextPeriods(gtuRows(), [{ id: "t1", text }]).map(withTermIndex);
    const view = lateralEntryForCase({ infos: [bachelor([text])], rows, fieldSources: [] });
    assert.equal(view?.durationYears, 3);
    assert.equal(view?.step, "ask");
    assert.equal(view?.startPeriod, "semester 3");
    assert.ok(view?.contradiction.reasons.includes("the transcript shows admission type D2D"));
  });

  it("transcript data exposes the first and last period printed", () => {
    const rows = applyTextPeriods(gtuRows(), [{ id: "t1", text: gtuText() }]).map(withTermIndex);
    const [s] = buildQualificationSummaries([bachelor()], rows, []);
    assert.deepEqual(s!.transcript.periodRange, { unit: "semester", first: 3, last: 8 });
    const y24 = [2, 3, 4].flatMap((y) => [sub(`A${y}`, `Year ${y}`), sub(`B${y}`, `Year ${y}`)]);
    assert.deepEqual(buildQualificationSummaries([bachelor()], y24, [])[0]!.transcript.periodRange, { unit: "year", first: 2, last: 4 });
    // Nothing counted from periods → no range.
    assert.equal(buildQualificationSummaries([bachelor()], [sub("A"), sub("B"), sub("C")], [])[0]!.transcript.periodRange, null);
  });

  it("normal semesters 1–8 → 4 years, Route 1", () => {
    const rows = Array.from({ length: 8 }, (_, i) => [sub(`Subject ${i}a`, `Semester ${i + 1}`), sub(`Subject ${i}b`, `Semester ${i + 1}`)]).flat();
    const c = countDuration(rows);
    assert.equal(c.countedYears, 4);
    assert.equal(c.finalYear, 4);
    assert.equal(lateralEntryForCase({ infos: [bachelor()], rows, fieldSources: [] })?.route, 1);
  });

  it("roman-numeral semesters V–VIII → 2 years", () => {
    const rows = ["V", "VI", "VII", "VIII"].flatMap((r) => [sub(`A ${r}`, `Semester ${r}`), sub(`B ${r}`, `Semester ${r}`)]);
    assert.equal(countDuration(rows).countedYears, 2);
  });

  it("years-based spans: Year 2–4 → 3 years, Year 1–3 → 3 years", () => {
    const y24 = [2, 3, 4].flatMap((y) => [sub(`A${y}`, `Year ${y}`), sub(`B${y}`, `Year ${y}`)]);
    const c = countDuration(y24);
    assert.equal(c.countedYears, 3);
    assert.equal(c.finalYear, 4);
    const y13 = [1, 2, 3].flatMap((y) => [sub(`A${y}`, `Year ${y}`), sub(`B${y}`, `Year ${y}`)]);
    assert.equal(countDuration(y13).countedYears, 3);
  });

  it("mixed 'Year 2 Semester 1' labels with year rows count the span", () => {
    const rows = [
      sub("A", "Year 2 Semester 1"),
      sub("B", "Year 2 Semester 2"),
      sub("C", "Year 3"),
      sub("D", "Year 4 Semester 1"),
      sub("E", "Year 4 Semester 2"),
    ];
    const c = countDuration(rows);
    assert.equal(c.countedYears, 3);
    assert.equal(startPeriodOf(rows)?.index, 3);
  });

  it("a single late year is a partial record, not counted from periods", () => {
    const rows = [sub("A", "Semester 7"), sub("B", "Semester 7"), sub("C", "Semester 8"), sub("D", "Semester 8")];
    const c = countDuration(rows);
    assert.equal(isReliableCount(c), false);
    assert.equal(c.confidence, "low");
  });
});

describe("admission notes are contradiction evidence only", () => {
  it("reads the admission field, not code legends", () => {
    assert.equal(admissionNoteOf(["ADMISSION TYPE : D2D"]), "D2D");
    assert.equal(admissionNoteOf(["Admission Type: Diploma to Degree"]), "Diploma to Degree");
    assert.equal(admissionNoteOf(["Admission : Lateral Entry   Branch: Civil"]), "Lateral Entry");
    assert.equal(admissionNoteOf(["Admission mode - Direct Second Year"]), "Direct Second Year");
    assert.equal(admissionNoteOf(["The student was admitted through lateral entry."]), "lateral entry");
    assert.equal(admissionNoteOf(["ADMISSION TYPE : REGULAR"]), null);
    assert.equal(admissionNoteOf(["C2D : admission at 2nd year (3rd semester) after diploma"]), null);
    assert.equal(admissionNoteOf(["ADMISSION: REGULAR, D2D: Diploma to Degree"]), null);
  });

  const base = {
    startPeriod: null,
    credit: { rows: 0, noted: false },
    priorSubjectsRead: false,
  };
  it("never asks the question at four years or more", () => {
    const d = decideLateralEntry({ ...base, durationYears: 4, admission: "D2D", state: EMPTY_LATERAL_STATE });
    assert.equal(d.route, 1);
  });
  it("under four years, a No with D2D on the transcript is re-confirmed", () => {
    const no = { ...EMPTY_LATERAL_STATE, answer: { value: "no" as const, at: "2026-11-01T00:00:00.000Z" } };
    const d = decideLateralEntry({ ...base, durationYears: 3, admission: "D2D", state: no });
    assert.equal(d.step, "reconfirm");
    assert.deepEqual(d.contradiction.reasons, ["the transcript shows admission type D2D"]);
    const plain = decideLateralEntry({ ...base, durationYears: 3, admission: null, state: no });
    assert.equal(plain.route, 2);
    assert.equal(plain.contradiction.fired, false);
  });
  it("adds to the other reasons", () => {
    const c = contradictionOf({ startPeriod: { index: 3, label: "semester 3" }, credit: { rows: 0, noted: false }, admission: "D2D" });
    assert.deepEqual(c.reasons, ["the transcript starts at semester 3", "the transcript shows admission type D2D"]);
  });
  it("Gate 1 bridging / credit-transfer flags do not fire for a D2D admission note", () => {
    const rows = [
      "Engineering Mathematics I", "Engineering Mechanics", "Thermodynamics", "Fluid Mechanics",
      "Machine Design", "Heat Transfer", "Manufacturing Processes", "Final Year Project",
    ].map((n) => sub(n));
    const q: QualificationInfo = {
      level: "bachelor",
      title: "Bachelor of Engineering (Mechanical)",
      countedYearsOverride: 4,
      texts: ["ADMISSION TYPE : D2D", "C2D : admission at 2nd year (3rd semester)"],
    };
    const g = evaluateGate1({ qualifications: [q], rows, vocational: voc });
    assert.deepEqual(g.qualifications[0]!.flags, []);
  });
});
