import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessExtractedSubjects } from "./assessCase.js";
import { resolveManualOccupation } from "./manualOccupation.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import { riskGateBlockReason } from "../risk/runRisk.js";
import type { AssessmentResult, ExtractedSubjectRow, Gate1Decision } from "./schemas.js";
import {
  applyWorkflowRouting,
  specialisationMastersCheck,
} from "./workflowRouting.js";

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
].map(sub);

const OPEN_MECH: QualificationInfo[] = [
  { level: "bachelor", title: "Bachelor of Engineering (Mechanical)", countedYearsOverride: 4 },
];

function stubResult(over: Partial<AssessmentResult>): AssessmentResult {
  return {
    anzscoCode: "233512",
    title: "Mechanical Engineer",
    recommended: true,
    confidence: "high",
    confidenceScore: 80,
    determination: "verified_no_risk",
    foundationalMatched: 5,
    foundationalExpected: 5,
    foundationalPct: 100,
    coreMatched: 8,
    coreExpected: 10,
    corePct: 80,
    tier1Outcome: "no_risk",
    tier2Outcome: "no_risk",
    tier3GateMet: true,
    workExperienceBoost: false,
    qualificationsUsed: ["bachelor"],
    matches: [],
    unmatched: [],
    extractedSubjects: [],
    explanation: "",
    candidates: [
      {
        anzscoCode: "233512",
        title: "Mechanical Engineer",
        recommended: true,
        confidence: "high",
        confidenceScore: 80,
        determination: "verified_no_risk",
        foundationalMatched: 5,
        foundationalExpected: 5,
        foundationalPct: 100,
        coreMatched: 8,
        coreExpected: 10,
        corePct: 80,
        tier1Outcome: "no_risk",
        tier2Outcome: "no_risk",
        tier3GateMet: true,
        matches: [],
        unmatched: [],
        missingSubjects: { tier1: [], tier2: [] },
        subjectCatalog: [],
      },
    ],
    gate1: { result: "open" } as Gate1Decision,
    ...over,
  };
}

describe("specialisationMastersCheck", () => {
  it("requires a Master's in a matching field", () => {
    const none = specialisationMastersCheck("233214", OPEN_MECH);
    assert.equal(none.ok, false);
    assert.match(none.message, /No Master's/);

    const wrong = specialisationMastersCheck("233214", [
      ...OPEN_MECH,
      { level: "master", title: "Master of Science" },
    ]);
    assert.equal(wrong.ok, false);
    assert.match(wrong.message, /does not match/);

    const structural = specialisationMastersCheck("233214", [
      ...OPEN_MECH,
      { level: "master", title: "Master of Engineering (Structural)" },
    ]);
    assert.equal(structural.ok, true);

    const civil = specialisationMastersCheck("233215", [
      { level: "bachelor", title: "Bachelor of Engineering (Civil)", countedYearsOverride: 4 },
      { level: "master", title: "Master of Civil Engineering" },
    ]);
    assert.equal(civil.ok, true);
  });
});

describe("applyWorkflowRouting", () => {
  it("does not auto-recommend below the 50% floor", () => {
    const r = applyWorkflowRouting(stubResult({ confidenceScore: 40, candidates: [
      { ...stubResult({}).candidates![0]!, confidenceScore: 40, recommended: true },
    ] }));
    assert.equal(r.recommended, false);
    assert.equal(r.workflowRouting?.code, "below_min_confidence");
    assert.equal(r.workflowRouting?.allowRisk, false);
    assert.match(riskGateBlockReason(r) ?? "", /below the 50%/);
  });

  it("lets a user-selected occupation below 50% go to risk with a flag", () => {
    const r = applyWorkflowRouting(
      stubResult({
        confidenceScore: 42,
        assessorSelected: {
          anzscoCode: "233512",
          title: "Mechanical Engineer",
          occupationId: "mechanical-engineer",
          source: "user",
        },
        candidates: [{ ...stubResult({}).candidates![0]!, confidenceScore: 42, recommended: false }],
      }),
      { userSelected: true },
    );
    assert.equal(r.recommended, false);
    assert.equal(r.workflowRouting?.code, "below_min_confidence");
    assert.equal(r.workflowRouting?.allowRisk, true);
    assert.equal(riskGateBlockReason(r), null);
  });

  it("blocks Structural without a matching Master's", () => {
    const r = applyWorkflowRouting(
      stubResult({
        anzscoCode: "233214",
        title: "Structural Engineer",
        candidates: [{ ...stubResult({}).candidates![0]!, anzscoCode: "233214", title: "Structural Engineer" }],
      }),
      { qualifications: OPEN_MECH },
    );
    assert.equal(r.workflowRouting?.code, "specialisation_masters");
    assert.equal(r.workflowRouting?.allowRisk, false);
    assert.equal(r.recommended, false);
  });
});

describe("Continue with this ANZSCO", () => {
  const mech = resolveManualOccupation("233512");
  assert.ok(mech.ok);
  const draftsperson = resolveManualOccupation("312311");
  assert.ok(draftsperson.ok);

  it("locks the occupation when Gate 1 is open and labels it User-selected", () => {
    const r = assessExtractedSubjects(ENG, {
      qualifications: OPEN_MECH,
      manualSelection: { ...mech.selection, source: "user" },
      userSelectedContinue: true,
    });
    assert.equal(r.gate1?.result, "open");
    assert.equal(r.assessorSelected?.source, "user");
    assert.equal(r.assessorSelected?.anzscoCode, "233512");
    assert.deepEqual(
      (r.candidates ?? []).map((c) => c.anzscoCode),
      ["233512"],
    );
  });

  it("sends Continue on a closed track to manual intervention", () => {
    const r = assessExtractedSubjects(ENG, {
      qualifications: OPEN_MECH,
      manualSelection: { ...draftsperson.selection, source: "user" },
      userSelectedContinue: true,
    });
    assert.equal(r.gate1?.result, "open");
    assert.equal(r.assessorSelected?.source, "user");
    assert.equal(r.workflowRouting?.code, "closed_track");
    assert.equal(r.workflowRouting?.allowRisk, false);
    assert.match(riskGateBlockReason(r) ?? "", /closed Gate 1 track/);
  });
});
