import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evidenceConfig } from "./evidenceConfig.js";
import { evaluateGate1, openTracks } from "./gate1.js";
import { listVocationalOccupations } from "./loadRubric.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import type { ExtractedSubjectRow, QualificationType } from "./schemas.js";
import { buildQualificationSummaries } from "./transcriptData.js";

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

/** Engineering subjects with no year / semester and no credits: nothing to count. */
const engRows = (qualification: QualificationType): ExtractedSubjectRow[] =>
  ENG.map((name) => ({
    name,
    code: null,
    credits: null,
    grade: null,
    yearOrSemester: null,
    qualification,
    sourceSnippet: null,
    isRepeat: false,
  }));

const gate = (q: QualificationInfo, rows: ExtractedSubjectRow[]) =>
  evaluateGate1({ qualifications: [q], rows, vocational: voc });

const advDip: QualificationInfo = { level: "advanced_diploma", title: "Advanced Diploma of Engineering (Mechanical)" };

describe("Advanced Diploma: default duration when none is found", () => {
  it("config: the default is 1 year", () => {
    assert.equal(evidenceConfig.gate.advancedDiplomaDefaultYears, 1);
  });

  it("no assessor entry, no printed periods, no credits → 1 year (default), Engineering Associate opens", () => {
    const g = gate(advDip, engRows("advanced_diploma"));
    assert.equal(g.result, "open");
    assert.equal(g.rule, 5);
    assert.deepEqual(
      openTracks(g).map((t) => t.track),
      ["engineering_associate"],
    );
    const q = g.qualifications[0]!;
    assert.equal(q.durationYears, 1);
    assert.equal(q.durationSource, "default");
    assert.equal(q.countedYears, null);
    assert.match(g.reason, /1 year \(default: no duration found on the transcript\)/);
  });

  it("assessor entered 0.5 years → not eligible (the entry wins over the default)", () => {
    const g = gate({ ...advDip, countedYearsOverride: 0.5 }, engRows("advanced_diploma"));
    assert.equal(g.result, "not_eligible");
    assert.equal(g.rule, 1);
    assert.equal(g.qualifications[0]!.durationSource, "counted");
    assert.deepEqual(openTracks(g), []);
  });

  it("assessor entered 2 years → used as entered, not the default", () => {
    const g = gate({ ...advDip, countedYearsOverride: 2 }, engRows("advanced_diploma"));
    assert.equal(g.rule, 5);
    assert.equal(g.qualifications[0]!.durationYears, 2);
    assert.equal(g.qualifications[0]!.durationSource, "counted");
  });

  it("Associate Degree with no duration → still manual review", () => {
    const g = gate({ level: "associate_degree", title: "Associate Degree in Engineering" }, engRows("associate_degree"));
    assert.equal(g.result, "manual_review");
    assert.equal(g.qualifications[0]!.durationSource, "none");
    assert.equal(g.qualifications[0]!.durationYears, null);
  });

  it("Bachelor with no duration → still manual review", () => {
    const g = gate({ level: "bachelor", title: "Bachelor of Engineering" }, engRows("bachelor"));
    assert.equal(g.result, "manual_review");
    assert.equal(g.qualifications[0]!.durationSource, "none");
  });

  it("Transcript data shows 1 year with a default status", () => {
    const [s] = buildQualificationSummaries([advDip], engRows("advanced_diploma"), []);
    assert.equal(s!.basis, "default");
    assert.equal(s!.effective.countedYears, 1);
    assert.equal(s!.transcript.countedYears, null);
    assert.equal(s!.durationCheck.status, "default");
    assert.equal(s!.durationCheck.ok, true);
    assert.match(s!.durationCheck.message, /^1 year \(default: no duration found on the transcript\)/);
  });

  it("Transcript data: Associate Degree with no duration stays missing", () => {
    const [s] = buildQualificationSummaries(
      [{ level: "associate_degree", title: "Associate Degree in Engineering" }],
      engRows("associate_degree"),
      [],
    );
    assert.equal(s!.basis, "none");
    assert.equal(s!.effective.countedYears, null);
    assert.equal(s!.durationCheck.status, "missing");
  });
});
