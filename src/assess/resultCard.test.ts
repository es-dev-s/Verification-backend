import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessExtractedSubjects } from "./assessCase.js";
import { flattenRubricSubjects, loadRubric } from "./loadRubric.js";
import { matchOptionsForRubric, matchSubjectsSync } from "./matchSubjects.js";
import { combineResultCards, isSubjectMarksTable, parseResultCard } from "./resultCard.js";
import type { ExtractedSubjectRow } from "./schemas.js";
import { usableTranscripts } from "./transcriptData.js";

function card(opts: {
  year: "FIRST" | "SECOND" | "THIRD";
  exam: number;
  registration?: string;
  program?: string;
  subjects: string[];
}): string {
  const rows = opts.subjects
    .map((subject, i) => `${i + 1} ${subject} | 100 | 70`)
    .join("\n");
  return [
    "PUNJAB BOARD OF TECHNICAL EDUCATION, LAHORE.",
    "RESULT CARD",
    `DIPLOMA OF ASSOCIATE ENGINEER, FIRST ANNUAL EXAMINATION, ${opts.exam}`,
    `Registration No. ${opts.registration ?? "100-200-300"}`,
    `${opts.program ?? "ELECTRICAL TECHNOLOGY"} (${opts.year} YEAR)`,
    "Detail is as under:",
    "Sr. No | Subjects / Papers | Maximum Marks Marks Obtained",
    rows,
  ].join("\n");
}

const YEAR1 = card({
  year: "FIRST",
  exam: 2015,
  subjects: [
    "GEN111 - ISLAMIAT AND PAKISTAN STUDIES",
    "ENG112 - ENGLISH",
    "MATH123 - APPLIED MATHEMATICS-I APPLIED MATHEMATICS-I (PAPER-A)",
    "CH132 - APPLIED CHEMISTRY",
    "ET115 - PRINCIPLES OF ELECTRICAL ENGINEERING",
    "ET121 - BASIC ELECTRICAL DRAWING",
  ],
});
const YEAR2 = card({
  year: "SECOND",
  exam: 2016,
  subjects: [
    "PHY222 - APPLIED PHYSICS",
    "ET213 - D.C MACHINES & BATTERIES",
    "ET242 - INSTALLATION PLANNING & ESTIMATING",
  ],
});
const YEAR3 = card({
  year: "THIRD",
  exam: 2017,
  subjects: [
    "ET335 - TRANSMISSION, DISTRIBUTION & PROTECTION OF ELECTRICAL POWER SYSTEMS",
    "ET315 - AC MACHINES",
    "ET322 - POWER PLANT & ENERGY CONSERVATION",
  ],
});

describe("result card marks tables", () => {
  it("reads a subject and marks table and ignores a plain certificate", () => {
    assert.equal(isSubjectMarksTable(YEAR1), true);
    assert.equal(isSubjectMarksTable("This is to certify that the candidate was awarded a diploma."), false);
    const parsed = parseResultCard(YEAR1, { qualification: "diploma" });
    assert.ok(parsed);
    assert.equal(parsed.registrationNumber, "100-200-300");
    assert.equal(parsed.studyYear, 1);
    assert.equal(parsed.examYear, 2015);
    assert.equal(parsed.program, "Electrical Technology");
    const names = parsed.subjects.map((s) => s.name);
    assert.ok(names.includes("Applied Mathematics-I"), names.join(" | "));
    assert.ok(names.includes("Applied Chemistry"));
    assert.ok(names.includes("Principles of Electrical Engineering"));
    assert.equal(names.filter((n) => /mathematic/i.test(n)).length, 1);
  });

  it("combines yearly cards with one registration into DAE Electrical Technology", () => {
    const cards = [YEAR1, YEAR2, YEAR3].map((text) => parseResultCard(text, { qualification: "diploma" })!);
    const combined = combineResultCards(cards);
    assert.deepEqual(combined, {
      registrationNumber: "100-200-300",
      title: "DAE Electrical Technology",
      years: 3,
      completionYear: 2017,
      degreeLevel: "diploma",
    });
    const other = parseResultCard(
      card({
        year: "FIRST",
        exam: 2014,
        registration: "999-999-999",
        program: "CIVIL TECHNOLOGY",
        subjects: ["MATH111 - APPLIED MATHEMATICS"],
      }),
      { qualification: "diploma" },
    )!;
    assert.equal(combineResultCards([...cards, other])?.registrationNumber, "100-200-300");
  });

  it("treats the marks table as a transcript and opens the Associate track only", () => {
    const now = new Date("2026-01-01");
    const docs = [
      { id: "c1", type: "CERTIFICATE", status: "DONE", text: YEAR1, degreeLevel: "diploma", createdAt: now },
      { id: "plain", type: "CERTIFICATE", status: "DONE", text: "Awarded a diploma.", degreeLevel: "diploma", createdAt: now },
    ];
    assert.deepEqual(usableTranscripts(docs).map((d) => d.id), ["c1"]);

    const rows = [YEAR1, YEAR2, YEAR3].flatMap(
      (text, i) => parseResultCard(text, { documentId: `c${i}`, qualification: "diploma" })!.subjects,
    );
    const result = assessExtractedSubjects(rows, {
      qualifications: [
        {
          level: "diploma",
          rawLevel: "diploma",
          title: "DAE Electrical Technology",
          completionYear: 2017,
          texts: [YEAR1, YEAR2, YEAR3],
        },
      ],
    });
    assert.equal(result.gate1?.result, "open");
    assert.equal(result.gate1?.rule, 5);
    const tracks = new Map((result.gate1?.tracks ?? []).map((t) => [t.track, t.open]));
    assert.equal(tracks.get("professional_engineer"), false);
    assert.equal(tracks.get("engineering_technologist"), false);
    assert.equal(tracks.get("engineering_associate"), true);
    const top = result.candidates?.[0];
    assert.ok(top, "an associate occupation should be scored");
    assert.equal(top.track, "engineering_associate");
    assert.ok(!result.candidates?.some((c) => c.anzscoCode.replace(/\s+/g, "") === "233914"));
    assert.equal(top.anzscoCode.replace(/\s+/g, ""), "312311");
  });

  it("maps the PBTE electrical names onto the 312311 headings", () => {
    const rubric = loadRubric("electrical-engineering-draftsperson-os");
    const names = ["English", "D.C Machines & Batteries", "Installation Planning & Estimating"];
    const rows: ExtractedSubjectRow[] = names.map((name) => ({
      name,
      code: null,
      credits: null,
      grade: null,
      yearOrSemester: null,
      qualification: "diploma",
      sourceSnippet: null,
      isRepeat: false,
    }));
    const { matches } = matchSubjectsSync(rows, flattenRubricSubjects(rubric), matchOptionsForRubric(rubric));
    const byName = new Map(matches.map((m) => [m.transcriptName, m.rubricSubject]));
    assert.equal(byName.get("English"), "English & Technical Communication");
    assert.equal(byName.get("D.C Machines & Batteries"), "Electrical Fundamentals & Machines");
    assert.equal(byName.get("Installation Planning & Estimating"), "Installation, Estimation & Standards");
  });
});
