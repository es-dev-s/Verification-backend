import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveAwardDetails, fieldOfStudyFromTitle, parseAwardLevel } from "./awardDetails.js";
import { evaluateGate1 } from "./gate1.js";
import { listVocationalOccupations } from "./loadRubric.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import { withTermIndex } from "./qualificationEvidence.js";
import type { ExtractedSubjectRow } from "./schemas.js";
import {
  buildQualificationSummaries,
  gateOverridesOf,
  overridesFor,
  qualificationInfosFor,
  TRANSCRIPT_FIELDS,
} from "./transcriptData.js";

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

function sub(name: string, yearOrSemester: string | null = null): ExtractedSubjectRow {
  return {
    name,
    code: null,
    credits: "3",
    grade: null,
    yearOrSemester,
    qualification: "bachelor",
    sourceSnippet: null,
    isRepeat: false,
  };
}

/** ENG subjects spread over `semesters` semesters (final project in the last one). */
const withSemesters = (semesters: number) =>
  ENG.map((n, i) => {
    const sem = n === "Final Year Project" ? semesters : Math.min(semesters, Math.floor((i * semesters) / (ENG.length - 1)) + 1);
    return sub(n, `Year ${Math.ceil(sem / 2)} Semester ${sem % 2 === 0 ? 2 : 1}`);
  }).map(withTermIndex);
const noTerms = () => ENG.map((n) => sub(n));

const bachelor = (durationYears: number | null, extra: Partial<QualificationInfo> = {}): QualificationInfo => ({
  level: "bachelor",
  rawLevel: "bachelor",
  title: "Bachelor of Engineering in Mechanical Engineering",
  durationYears,
  ...extra,
});

const fs = (field: string, finalValue: string | null, degreeLevel: string | null = "bachelor") => ({
  field,
  degreeLevel,
  extractedValue: null,
  finalValue,
});

describe("Phase 1: award level and field of study", () => {
  it("derives award, AQF level and field of study from the title", () => {
    const d = deriveAwardDetails({ degreeLevel: "bachelor", title: "Bachelor of Engineering (Honours) in Civil Engineering" });
    assert.equal(d.awardLevel, "honours");
    assert.equal(d.aqfLevel, 8);
    assert.equal(d.fieldOfStudy, "Civil Engineering");
    const m = deriveAwardDetails({ degreeLevel: "master", title: "Master of Engineering" });
    assert.equal(m.awardLevel, "master");
    assert.equal(m.aqfLevel, 9);
  });

  it("reads the field of study from common title shapes", () => {
    assert.equal(fieldOfStudyFromTitle("Bachelor of Civil Engineering"), "Civil Engineering");
    assert.equal(fieldOfStudyFromTitle("B.Tech Mechanical Engineering"), "Mechanical Engineering");
    assert.equal(fieldOfStudyFromTitle("Bachelor of Science Computer Science"), "Computer Science");
    assert.equal(fieldOfStudyFromTitle("Bachelor of Engineering"), "Engineering");
    assert.equal(fieldOfStudyFromTitle("Bachelor of Science"), null);
    assert.equal(fieldOfStudyFromTitle(null), null);
  });

  it("parses stored award values", () => {
    assert.equal(parseAwardLevel("diploma"), "diploma");
    assert.equal(parseAwardLevel("unknown"), null);
    assert.equal(parseAwardLevel("nonsense"), null);
    assert.equal(parseAwardLevel(null), null);
  });
});

describe("Phase 2: transcript summary", () => {
  it("counts duration, credits and the final-year project", () => {
    const [s] = buildQualificationSummaries([bachelor(4)], withSemesters(8), []);
    assert.equal(s!.transcript.countedYears, 4);
    assert.equal(s!.transcript.terms, 8);
    assert.equal(s!.transcript.creditTotal, 36);
    assert.equal(s!.effective.finalProject?.title, "Final Year Project");
    assert.equal(s!.effective.finalProject?.inFinalYear, true);
    assert.equal(s!.basis, "counted");
    assert.equal(s!.subjectCount, ENG.length);
  });

  it("uses saved overrides (null = transcript value)", () => {
    const sources = [
      fs(TRANSCRIPT_FIELDS.creditTotal, "120"),
      fs(TRANSCRIPT_FIELDS.finalProject, "Capstone design"),
      fs(TRANSCRIPT_FIELDS.engineeringShare, "0.8"),
      fs(TRANSCRIPT_FIELDS.countedYears, null),
    ];
    assert.deepEqual(overridesFor(sources, "bachelor"), {
      countedYears: null,
      creditTotal: 120,
      finalProject: "Capstone design",
      engineeringShare: 0.8,
    });
    const [s] = buildQualificationSummaries([bachelor(4)], withSemesters(8), sources);
    assert.equal(s!.effective.creditTotal, 120);
    assert.equal(s!.effective.finalProject?.title, "Capstone design");
    assert.equal(s!.effective.engineeringShare, 0.8);
    assert.equal(s!.effective.countedYears, 4);
  });
});

describe("Phase 3: duration check (0.5-year tolerance)", () => {
  it("match within tolerance passes", () => {
    const [s] = buildQualificationSummaries([bachelor(4)], withSemesters(8), []);
    assert.equal(s!.durationCheck.status, "match");
    assert.equal(s!.durationCheck.ok, true);
    assert.equal(s!.durationCheck.toleranceYears, 0.5);
    const [half] = buildQualificationSummaries([bachelor(3.5)], withSemesters(8), []);
    assert.equal(half!.durationCheck.status, "match");
  });

  it("mismatch needs manual review", () => {
    const [s] = buildQualificationSummaries([bachelor(3)], withSemesters(8), []);
    assert.equal(s!.durationCheck.status, "mismatch");
    assert.equal(s!.durationCheck.ok, false);
    assert.equal(s!.durationCheck.differenceYears, 1);
  });

  it("a manual counted duration resolves the mismatch", () => {
    const sources = [fs(TRANSCRIPT_FIELDS.countedYears, "3")];
    const [s] = buildQualificationSummaries([bachelor(3)], withSemesters(8), sources);
    assert.equal(s!.basis, "manual");
    assert.equal(s!.durationCheck.status, "match");
    assert.equal(s!.durationCheck.ok, true);
  });

  it("no countable terms falls back to the stated duration", () => {
    const [s] = buildQualificationSummaries([bachelor(4)], noTerms(), []);
    assert.equal(s!.durationCheck.status, "fallback");
    assert.equal(s!.durationCheck.ok, true);
    assert.equal(s!.fallback, true);
  });

  it("no stated and no counted duration blocks", () => {
    const [s] = buildQualificationSummaries([bachelor(null)], noTerms(), []);
    assert.equal(s!.durationCheck.status, "missing");
    assert.equal(s!.durationCheck.ok, false);
  });
});

describe("Assessor values reach Gate 1", () => {
  const quals = [
    {
      degreeLevel: "bachelor",
      degreeTitle: "Bachelor of Engineering in Mechanical Engineering",
      durationYears: 3,
      country: null,
      institution: null,
    },
  ];

  it("award level and counted duration overrides", () => {
    const sources = [fs("awardLevel", "honours"), fs(TRANSCRIPT_FIELDS.countedYears, "3")];
    const infos = qualificationInfosFor(quals, [], sources);
    assert.equal(infos[0]!.awardOverride, "honours");
    assert.equal(infos[0]!.countedYearsOverride, 3);
    const g = evaluateGate1({ qualifications: infos, rows: withSemesters(8), vocational: voc });
    assert.equal(g.qualifications[0]!.award, "honours");
    assert.equal(g.qualifications[0]!.countedYears, 3);
    assert.equal(g.qualifications[0]!.durationYears, 3);
    assert.ok(gateOverridesOf(infos));
  });

  it("no overrides and a field already in the title leave the gate key unchanged", () => {
    const infos = qualificationInfosFor(quals, [], [fs("fieldOfStudy", "Mechanical Engineering")]);
    assert.equal(gateOverridesOf(infos), null);
    assert.equal(gateOverridesOf(qualificationInfosFor(quals, [], [])), null);
  });

  it("engineering share override is used by the summary and the gate input", () => {
    const sources = [fs(TRANSCRIPT_FIELDS.engineeringShare, "0.1")];
    const infos = qualificationInfosFor(quals, [], sources);
    assert.equal(infos[0]!.engineeringShareOverride, 0.1);
    const [s] = buildQualificationSummaries(infos, withSemesters(8), sources);
    assert.equal(s!.effective.engineeringShare, 0.1);
  });
});
