import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessExtractedSubjects,
  checkOccupation,
  checkOccupationForCase,
  type CheckCaseLoader,
} from "./assessCase.js";
import {
  MANUAL_ANZSCO_FIELD,
  NoSavedSubjectsError,
  TELECOM_NEEDS_ICT60220,
  TelecomNeedsIct60220Error,
} from "./manualOccupation.js";
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

describe("assessor pick of a telecommunications group code", () => {
  function unit(code: string, title: string): ExtractedSubjectRow {
    return { ...sub(`${code} ${title}`), code, qualification: "advanced_diploma" };
  }
  const ROWS = [
    unit("BSBCRT611", "Apply critical thinking for complex problem solving"),
    unit("BSBTWK502", "Manage team effectiveness"),
    unit("BSBXCS402", "Promote workplace cyber security awareness and best practices"),
    unit("ICTICT608", "Interact with clients on a business level"),
    unit("ICTICT618", "Manage IT projects"),
    unit("ICTSAD609", "Plan and monitor business analysis activities in an ICT environment"),
    unit("ICTNPL413", "Evaluate networks and associated plans"),
    unit("ICTNWK612", "Plan and manage troubleshooting advanced integrated IP networks"),
    unit("ICTPMG613", "Manage ICT project planning"),
    unit("ICTTEN615", "Manage network traffic"),
    unit("ICTTEN622", "Produce ICT network architecture designs"),
  ];
  const ICT: QualificationInfo[] = [
    {
      level: "advanced_diploma",
      title: "ICT60220 Advanced Diploma of Information Technology",
      countedYearsOverride: 2,
      engineeringShareOverride: 1,
    },
  ];
  const NO_ICT: QualificationInfo[] = [
    {
      level: "advanced_diploma",
      title: "Advanced Diploma of Engineering",
      countedYearsOverride: 2,
      engineeringShareOverride: 1,
    },
  ];

  it("with ICT60220, 313212 and 313213 are matched by the telecom group logic", () => {
    for (const [id, code] of [
      ["313212", "313212"],
      ["telecommunications-network-planner", "313213"],
    ] as const) {
      const check = checkOccupation(ROWS, { qualifications: ICT }, id);
      assert.ok(check, id);
      assert.equal(check.candidate.anzscoCode, code);
      assert.ok(check.candidate.suggestionStatus, `${id} is a telecom group result`);
    }
  });

  it("without ICT60220, 313212 and 313213 stop with the ICT60220 message", () => {
    for (const id of ["313212", "313213", "telecommunications-network-planner"]) {
      assert.throws(
        () => checkOccupation(ROWS, { qualifications: NO_ICT }, id),
        (err: unknown) => err instanceof TelecomNeedsIct60220Error && err.message === TELECOM_NEEDS_ICT60220,
        id,
      );
    }
  });

  it("case check without ICT60220 rejects with the message (route sends it as 422)", async () => {
    const caseRow = {
      id: "case-telecom",
      engineeringTitledDegree: false,
      documents: [],
      qualifications: [
        { degreeLevel: "advanced_diploma", degreeTitle: "Advanced Diploma of Engineering", country: null, institution: null },
      ],
      extractedSubjects: ROWS.map((r, i) => ({ ...r, id: `t${i}`, sortOrder: i, documentId: null })),
      fieldSources: [],
      assessment: null,
    };
    await assert.rejects(
      checkOccupationForCase("case-telecom", "313212", (async () => caseRow) as unknown as CheckCaseLoader),
      (err: unknown) => err instanceof TelecomNeedsIct60220Error && err.message === TELECOM_NEEDS_ICT60220,
    );
  });

  it("a saved telecom choice on a case without ICT60220 does not break the assessment", () => {
    const res = assessExtractedSubjects(ROWS, {
      qualifications: NO_ICT,
      manualSelection: { occupationId: "313212", anzscoCode: "313212", title: "Telecommunications Field Engineer" },
    } as Parameters<typeof assessExtractedSubjects>[1]);
    assert.ok(res);
    assert.notEqual(res.assessorSelected?.occupationId, "313212");
  });
});
