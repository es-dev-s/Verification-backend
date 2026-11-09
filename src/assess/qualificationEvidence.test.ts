import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessExtractedSubjects, scoreRoutedOccupations } from "./assessCase.js";
import {
  countDuration,
  creditsToYears,
  decideEngineering,
  detectCreditSystem,
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

const chemQual = (countedYearsOverride: number | null = null): QualificationInfo => ({
  level: "bachelor",
  title: "Bachelor of Engineering (Chemical)",
  countedYearsOverride,
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

  it("duration basis carries the counted years for Gate 1", () => {
    const [b] = durationBasisFor(chemWithSemesters(6), [chemQual()]);
    assert.equal(b!.count.countedYears, 3);
  });

  it("Gate 1 opens Professional Engineer on a counted 4 years", () => {
    const full = assessExtractedSubjects(chemWithSemesters(8), { qualifications: [chemQual()] });
    assert.equal(full.gate1?.result, "open");
    assert.equal(full.gate1?.rule, 3);
    assert.equal(full.anzscoCode, "233111");
  });

  it("Gate 1: a counted 3-year bachelor does not open Professional Engineer", () => {
    const short = assessExtractedSubjects(chemWithSemesters(6), { qualifications: [chemQual()] });
    assert.notEqual(short.gate1?.rule, 3);
  });

  it("saved rows without terms or credits and no entry → manual review (no scores)", () => {
    const plain = CHEM.map((n) => sub(n));
    const res = assessExtractedSubjects(plain, { qualifications: [chemQual()] });
    assert.equal(res.gate1?.result, "manual_review");
    assert.match(res.gate1?.reason ?? "", /could not be counted from the transcript/);
    assert.deepEqual(res.candidates, []);
    assert.equal(res.confidenceScore, 0);
  });

  it("saved rows without terms but a duration entered in Transcript data → used", () => {
    const plain = CHEM.map((n) => sub(n));
    const res = assessExtractedSubjects(plain, { qualifications: [chemQual(4)] });
    assert.equal(res.gate1?.result, "open");
    assert.equal(res.anzscoCode, "233111");
  });
});

describe("B2. credits → years (no printed years / semesters)", () => {
  /** CHEM subjects with no term, `each` credits per subject (16 subjects). */
  const noTerms = (each: string) => CHEM.map((n) => sub(n, null, "bachelor", each));

  it("converts the credit total at the default 30 per year", () => {
    const c = countDuration(noTerms("7.5")); // 120 credits
    assert.equal(c.source, "credits");
    assert.equal(c.countedYears, 4);
    assert.equal(c.confidence, "medium");
    assert.equal(c.creditConversion?.perYear, 30);
    assert.equal(c.creditConversion?.label, "Converted from credits (120 credits ÷ 30 per year)");
  });

  it("uses ECTS 60 per year when the transcript names ECTS", () => {
    const c = countDuration(noTerms("15 ECTS")); // 240 ECTS
    assert.equal(c.creditConversion?.system, "ects");
    assert.equal(c.countedYears, 4);
    assert.equal(c.creditConversion?.label, "Converted from credits (240 credits ÷ 60 per year)");
  });

  it("detects the system from the country (Australia 48, Germany ECTS, US 30)", () => {
    assert.equal(detectCreditSystem([], { country: "Australia" }), "australianCreditPoints");
    assert.equal(detectCreditSystem([], { country: "Germany" }), "ects");
    assert.equal(detectCreditSystem([], { country: "United States" }), "usSemester");
    assert.equal(detectCreditSystem([{ credits: "3 semester hours" }]), "usSemester");
    assert.equal(detectCreditSystem([{ credits: "3" }], { country: "Nepal" }), "default");
    const au = countDuration(noTerms("12"), { country: "Australia" }); // 192 cp
    assert.equal(au.countedYears, 4);
    assert.equal(au.creditConversion?.perYear, 48);
  });

  it("printed semesters win over credits", () => {
    const c = countDuration(chemWithSemesters(8));
    assert.equal(c.source, "terms");
    assert.equal(c.creditConversion, null);
    assert.equal(c.countedYears, 4);
  });

  it("an assessor credit total replaces the transcript total", () => {
    const c = countDuration(noTerms("7.5"), { creditTotalOverride: 90 });
    assert.equal(c.countedYears, 3);
    assert.equal(c.creditConversion?.credits, 90);
  });

  it("ignores no or implausible credit totals", () => {
    assert.equal(countDuration(CHEM.map((n) => sub(n))).source, null);
    assert.equal(creditsToYears(0, "default"), null);
    assert.equal(creditsToYears(600, "default"), null); // 20 years
  });

  it("Gate 1 uses the years converted from credits", () => {
    const res = assessExtractedSubjects(noTerms("7.5"), { qualifications: [chemQual()] });
    assert.equal(res.gate1?.result, "open");
    assert.equal(res.gate1?.rule, 3);
    assert.equal(res.gate1?.creditConversionNote, "Converted from credits (120 credits ÷ 30 per year)");
    const q = res.gate1?.qualifications[0];
    assert.equal(q?.durationSource, "counted");
    assert.equal(q?.countedYears, 4);
  });

  it("Gate 1: converted 3 years does not open Professional Engineer", () => {
    const res = assessExtractedSubjects(noTerms("5.625"), { qualifications: [chemQual()] }); // 90
    assert.equal(res.gate1?.qualifications[0]?.countedYears, 3);
    assert.notEqual(res.gate1?.rule, 3);
  });

  it("Gate 1: a manual counted duration still wins over credits", () => {
    const res = assessExtractedSubjects(noTerms("5.625"), {
      qualifications: [chemQual(4)],
    });
    assert.equal(res.gate1?.result, "open");
    assert.equal(res.gate1?.creditConversionNote, null);
  });
});


describe("B3. seasonal Fall/Spring headings (OCR text)", () => {
  const uetText = [
    "UNIVERSITY OF ENGINEERING AND TECHNOLOGY LAHORE",
    "Fall 2017",
    "Spring 2018",
    "Summer 2018",
    "Fall 2018",
    "Spring 2019",
    "Fall 2019",
    "Spring 2020",
    "Fall 2020",
    "Spring 2021",
    "Total Credits 135 CH Degree Complete",
  ].join("\n");

  /** Left-column-only rows: Fall 2017 through Spring 2019 → 2 academic years alone. */
  const truncatedRows = (): ExtractedSubjectRow[] => [
    sub("Introduction to Engineering", "Fall 2017", "bachelor", "2"),
    sub("Engineering Geology", "Fall 2017", "bachelor", "3"),
    sub("Mining Engineering Fundamentals", "Spring 2018", "bachelor", "3"),
    sub("Fluid Mechanics", "Fall 2018", "bachelor", "3"),
    sub("Thermodynamics", "Spring 2019", "bachelor", "3"),
    sub("Mine Surveying", "Spring 2019", "bachelor", "3"),
  ];

  const fullSeasonRows = (): ExtractedSubjectRow[] => [
    sub("Introduction to Engineering", "Fall 2017", "bachelor", "2"),
    sub("Mining Engineering Fundamentals", "Spring 2018", "bachelor", "3"),
    sub("Fluid Mechanics", "Fall 2018", "bachelor", "3"),
    sub("Thermodynamics", "Spring 2019", "bachelor", "3"),
    sub("Rock Mechanics", "Fall 2019", "bachelor", "3"),
    sub("Mine Ventilation", "Spring 2020", "bachelor", "3"),
    sub("Mineral Processing", "Fall 2020", "bachelor", "3"),
    sub("Final Year Project", "Spring 2021", "bachelor", "6"),
  ];

  it("truncated calendar rows are lifted to 4 years by Fall/Spring headings in the text", () => {
    const c = countDuration(truncatedRows(), { texts: [uetText] });
    assert.equal(c.countedYears, 4);
    assert.equal(c.source, "terms");
    assert.equal(c.confidence, "medium");
    assert.equal(c.unit, "calendar");
    assert.match(c.method, /fall\/spring headings on the transcript/);
    assert.match(c.method, /2017\u20132020/);
  });

  it("full seasons on subject rows still count as 4 years", () => {
    const c = countDuration(fullSeasonRows(), { texts: [uetText] });
    assert.equal(c.countedYears, 4);
    assert.equal(c.source, "terms");
  });

  it("numbered semester headings still win over seasonal words in the same text", () => {
    const text = [
      "Semester 3 Fall 2018",
      "Semester 4 Spring 2019",
      "Semester 5 Fall 2019",
      "Semester 6 Spring 2020",
      "Semester 7 Fall 2020",
      "Semester 8 Spring 2021",
    ].join("\n");
    const c = countDuration([sub("Engineering Mathematics"), sub("Engineering Drawing")], {
      texts: [text],
    });
    assert.equal(c.countedYears, 3);
    assert.match(c.method ?? "", /semester headings/);
    assert.match(c.method ?? "", /semesters 3\u20138/);
  });
  it("Semester CH / GPA glue noise does not force 2 years over Fall/Spring rows", () => {
    const noisy = [
      "UNIVERSITY OF ENGINEERING AND TECHNOLOGY LAHORE",
      "WaringFall 2017",
      "MinE-111 Introduction to Mining 2.7 Semester CH: 17.0",
      "Spring 2018 Fluid Mechanics 5.4 Semester CH: 18.0",
      "Fall 2019MinE-351 Rock Mechanics 9.9Semester CH: 16.0",
      "Summer 2020",
      "Fall 2020",
      "Spring 2021 Final Year Project",
      "Cum CH: 135 Degree Complete",
    ].join("\n");
    const rows = [
      sub("Introduction to Engineering", "Fall 2017", "bachelor", "2"),
      sub("Mining Engineering Fundamentals", "Spring 2018", "bachelor", "3"),
      sub("Fluid Mechanics", "Fall 2018", "bachelor", "3"),
      sub("Thermodynamics", "Spring 2019", "bachelor", "3"),
      sub("Rock Mechanics", "Fall 2019", "bachelor", "3"),
      sub("Mine Ventilation", "Spring 2020", "bachelor", "3"),
      sub("Mineral Processing", "Fall 2020", "bachelor", "3"),
      sub("Final Year Project", "Spring 2021", "bachelor", "6"),
    ];
    const c = countDuration(rows, { texts: [noisy] });
    assert.equal(c.countedYears, 4);
    assert.notEqual(c.unit, "semester");
    assert.doesNotMatch(c.method ?? "", /semester headings/);
  });

  it("weak false semester headings lose to a longer reliable calendar row span", () => {
    const rows = [
      sub("Introduction to Engineering", "Fall 2017", "bachelor", "2"),
      sub("Mining Engineering Fundamentals", "Spring 2018", "bachelor", "3"),
      sub("Fluid Mechanics", "Fall 2018", "bachelor", "3"),
      sub("Thermodynamics", "Spring 2019", "bachelor", "3"),
      sub("Rock Mechanics", "Fall 2019", "bachelor", "3"),
      sub("Mine Ventilation", "Spring 2020", "bachelor", "3"),
      sub("Mineral Processing", "Fall 2020", "bachelor", "3"),
      sub("Final Year Project", "Spring 2021", "bachelor", "6"),
    ];
    const text = "Semester 7\nSemester 8\nSemester 9";
    const c = countDuration(rows, { texts: [text] });
    assert.equal(c.countedYears, 4);
    assert.equal(c.unit, "calendar");
    assert.match(c.method ?? "", /academic years printed/);
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
    const res = assessExtractedSubjects(chemWithSemesters(8), { qualifications: [chemQual()] });
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
    const d = decideEngineering({ qualifications: [chemQual()], rows: CHEM.map((n) => sub(n)) });
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
      { level: "bachelor", title: "Bachelor of Business Administration", countedYearsOverride: 4 },
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
