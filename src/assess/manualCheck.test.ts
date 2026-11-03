import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessExtractedSubjects,
  checkOccupation,
  checkOccupationForCase,
  type CheckCaseLoader,
} from "./assessCase.js";
import { MANUAL_ANZSCO_FIELD, NoSavedSubjectsError } from "./manualOccupation.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import type { ExtractedSubjectRow } from "./schemas.js";

function sub(name: string): ExtractedSubjectRow {
  return {
    name,
    code: null,
    credits: null,
    grade: null,
    yearOrSemester: null,
    qualification: "bachelor",
    sourceSnippet: null,
    isRepeat: false,
  };
}

const NAMES = [
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
const ENG = NAMES.map(sub);

const OPEN: QualificationInfo[] = [
  { level: "bachelor", title: "Bachelor of Engineering (Mechanical)", countedYearsOverride: 4 },
];
const MANUAL_REVIEW: QualificationInfo[] = [
  // Part-time study is a Gate 1 manual-review flag (lateral-entry titles now
  // go through the lateral-entry check instead of manual review).
  { level: "bachelor", title: "Bachelor of Engineering (Mechanical) (Part-time)", countedYearsOverride: 4 },
];

describe("assessor ANZSCO check (read-only)", () => {
  it("does not alter the assessment result or its recommended occupation", () => {
    const result = assessExtractedSubjects(ENG, { qualifications: OPEN });
    const snapshot = structuredClone(result);
    const rows = structuredClone(ENG);
    const check = checkOccupation(rows, { qualifications: OPEN }, "civil-engineer");
    assert.ok(check);
    assert.equal(check.candidate.anzscoCode, "233211");
    assert.deepEqual(result, snapshot, "result unchanged");
    assert.deepEqual(rows, ENG, "subjects unchanged");
    assert.equal(
      assessExtractedSubjects(ENG, { qualifications: OPEN }).anzscoCode,
      snapshot.anzscoCode,
      "recommended occupation unchanged",
    );
  });

  it("an occupation in an open track scores exactly like its ranked card", () => {
    const result = assessExtractedSubjects(ENG, { qualifications: OPEN });
    const card = result.candidates!.find((c) => c.anzscoCode === "233512")!;
    const check = checkOccupation(ENG, { qualifications: OPEN }, "mechanical-engineer");
    assert.ok(card && check);
    assert.equal(check.trackOpen, true);
    for (const k of [
      "foundationalMatched",
      "foundationalExpected",
      "coreMatched",
      "coreExpected",
      "confidence",
      "confidenceScore",
      "determination",
    ] as const) {
      assert.equal(check.candidate[k], card[k], k);
    }
  });

  it("Gate 1 never blocks the check; the result says the track was not opened", () => {
    const check = checkOccupation(ENG, { qualifications: MANUAL_REVIEW }, "mechanical-engineer");
    assert.ok(check);
    assert.equal(check.gateResult, "manual_review");
    assert.equal(check.trackOpen, false);
    assert.ok(check.trackLabel);
    assert.ok(check.candidate.matches.length > 0);
  });

  it("returns null for an occupation without a usable rubric", () => {
    assert.equal(checkOccupation(ENG, { qualifications: OPEN }, "no-such-occupation"), null);
  });

  it("case check only reads the case: saved result, manual choice and rows stay untouched", async () => {
    const savedResult = { anzscoCode: "233512", recommended: true, candidates: [] };
    const caseRow = {
      id: "case-check",
      engineeringTitledDegree: true,
      documents: [],
      qualifications: [
        {
          degreeLevel: "bachelor",
          degreeTitle: "Bachelor of Engineering (Mechanical)",
          country: null,
          institution: null,
        },
      ],
      extractedSubjects: NAMES.map((name, i) => ({
        ...sub(name),
        id: `s${i}`,
        sortOrder: i,
        documentId: null,
      })),
      fieldSources: [
        { field: MANUAL_ANZSCO_FIELD, degreeLevel: null, finalValue: "mechanical-engineer" },
      ],
      assessment: { inputHash: "h", resultJson: savedResult },
    };
    const before = structuredClone(caseRow);
    const loads: string[] = [];
    const load = (async (id: string) => {
      loads.push(id);
      return caseRow;
    }) as unknown as CheckCaseLoader;

    const check = await checkOccupationForCase("case-check", "civil-engineer", load);
    assert.ok(check);
    assert.equal(check.candidate.anzscoCode, "233211");
    assert.deepEqual(loads, ["case-check"], "one read, nothing else");
    assert.deepEqual(caseRow, before, "case, saved result and manual choice unchanged");

    const empty = { ...structuredClone(caseRow), extractedSubjects: [] };
    await assert.rejects(
      checkOccupationForCase("case-check", "civil-engineer", (async () => empty) as unknown as CheckCaseLoader),
      NoSavedSubjectsError,
    );
  });
});
