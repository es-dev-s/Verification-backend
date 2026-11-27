import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assessExtractedSubjects } from "./assessCase.js";
import { resolveManualOccupation } from "./manualOccupation.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import { riskGateBlockReason } from "../risk/runRisk.js";
import type { AssessmentResult, ExtractedSubjectRow, Gate1Decision } from "./schemas.js";
import {
  applyWorkflowRouting,
  loadTrackStatus,
  routingForSelectedOccupation,
  specialisationMastersCheck,
  trackListCloses,
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
    assert.match(wrong.message, /could not be read/);

    const structural = specialisationMastersCheck("233214", [
      ...OPEN_MECH,
      { level: "master", title: "Master of Engineering (Structural)" },
    ]);
    assert.equal(structural.ok, true);

    const transport = specialisationMastersCheck("233215", [
      { level: "bachelor", title: "Bachelor of Engineering (Civil)", countedYearsOverride: 4 },
      { level: "master", title: "Master of Transportation Engineering", institution: "Uni" },
    ]);
    assert.equal(transport.ok, true);

    const civilOnly = specialisationMastersCheck("233214", [
      ...OPEN_MECH,
      { level: "master", title: "Master of Civil Engineering", institution: "Uni", fieldOfStudy: "Civil Engineering" },
    ]);
    assert.equal(civilOnly.ok, false);
    assert.match(civilOnly.message, /does not match/);
    assert.equal(civilOnly.masters[0]?.institution, "Uni");

    const unread = specialisationMastersCheck("233212", [
      { level: "master", title: "Master of Science", institution: "Uni" },
    ]);
    assert.equal(unread.ok, false);
    assert.match(unread.message, /could not be read/);

    const soil = specialisationMastersCheck("233212", [
      { level: "master", title: "Master of Engineering", fieldOfStudy: "Soil Mechanics", institution: "Uni" },
    ]);
    assert.equal(soil.ok, true);
  });
});

describe("track list", () => {
  it("closes a track only when the maintained list says closed", () => {
    assert.equal(trackListCloses("233512", { professional_engineer: "open" }), false);
    assert.equal(trackListCloses("233512", { professional_engineer: "closed" }), true);
    assert.equal(trackListCloses("312311", { engineering_associate: "closed" }), true);
  });

  it("re-reads track-status.json on each check", () => {
    const dir = mkdtempSync(join(tmpdir(), "track-status-"));
    const file = join(dir, "track-status.json");
    const body = (status: "open" | "closed") =>
      JSON.stringify({
        professional_engineer: status,
        engineering_technologist: "open",
        engineering_associate: "open",
      });
    writeFileSync(file, body("open"));
    assert.equal(trackListCloses("233512", loadTrackStatus(file)), false);
    writeFileSync(file, body("closed"));
    assert.equal(trackListCloses("233512", loadTrackStatus(file)), true);
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
    assert.match(riskGateBlockReason(r) ?? "", /No ANZSCO reached 50%/);
    assert.equal(r.workflowRouting?.topScores?.[0]?.confidenceScore, 40);
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
    assert.match(riskGateBlockReason(r) ?? "", /Chosen ANZSCO is in a closed track/);
    assert.equal(r.workflowRouting?.closedTrack?.anzscoCode, "312311");
  });

  it("sends an alternative Geotechnical selection with no Master's to manual intervention", () => {
    const geo = resolveManualOccupation("233212");
    assert.ok(geo.ok);
    const r = assessExtractedSubjects(ENG, {
      qualifications: OPEN_MECH,
      manualSelection: { ...geo.selection, source: "user" },
      userSelectedContinue: true,
    });
    assert.equal(r.assessorSelected?.anzscoCode, "233212");
    assert.equal(r.workflowRouting?.code, "specialisation_masters");
    assert.equal(r.workflowRouting?.allowRisk, false);
    assert.match(r.workflowRouting?.message ?? "", /No Master's was found/);
    const recommendedWouldAllow = riskGateBlockReason({
      gate1: r.gate1,
      workflowRouting: {
        kind: "ok",
        code: null,
        message: "",
        minConfidence: 50,
        highestConfidence: 80,
        allowRisk: true,
      },
    });
    assert.equal(recommendedWouldAllow, null);
    const selected = routingForSelectedOccupation({
      anzscoCode: "233212",
      confidenceScore: 80,
      gate: r.gate1,
      qualifications: OPEN_MECH,
    });
    assert.equal(selected.allowRisk, false);
    assert.match(riskGateBlockReason({ gate1: r.gate1, workflowRouting: selected }) ?? "", /No Master's/);
  });
});
