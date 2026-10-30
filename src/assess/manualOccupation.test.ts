import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { riskGateBlockReason } from "../risk/runRisk.js";
import { assessExtractedSubjects } from "./assessCase.js";
import {
  listManualOccupationOptions,
  MANUAL_ANZSCO_FIELD,
  manualSelectionFrom,
  resolveManualOccupation,
} from "./manualOccupation.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import type { ExtractedSubjectRow, Gate1Decision } from "./schemas.js";
import { resolveSubjects } from "./transcriptData.js";

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

/** Gate 1 = manual review (bridging / lateral-entry title). */
const MANUAL_REVIEW: QualificationInfo[] = [
  { level: "bachelor", title: "Bachelor of Engineering (Lateral Entry)", durationYears: 3 },
];
const OPEN: QualificationInfo[] = [
  { level: "bachelor", title: "Bachelor of Engineering (Mechanical)", durationYears: 4 },
];

describe("manual occupation options", () => {
  const options = listManualOccupationOptions();

  it("lists rubric occupations as available and codes without a rubric as not", () => {
    const mech = options.find((o) => o.anzscoCode === "233512");
    assert.equal(mech?.available, true);
    assert.equal(mech?.occupationId, "mechanical-engineer");
    assert.equal(mech?.flow, "academic");
    const noRubric = options.find((o) => o.anzscoCode === "263312");
    assert.equal(noRubric?.available, false);
    assert.equal(noRubric?.occupationId, null);
    assert.match(noRubric?.unavailableReason ?? "", /No rubric/);
    const elec = options.find((o) => o.anzscoCode === "312311");
    assert.equal(elec?.flow, "vocational_units");
    assert.equal(elec?.available, true);
    assert.equal(options.filter((o) => o.anzscoCode === "233999").length, 2);
  });

  it("resolves a code or an occupation id; rejects unknown, no-rubric and ambiguous codes", () => {
    const ok = resolveManualOccupation("233512", options);
    assert.ok(ok.ok);
    assert.deepEqual(ok.selection, {
      occupationId: "mechanical-engineer",
      anzscoCode: "233512",
      title: options.find((o) => o.anzscoCode === "233512")!.title,
    });
    const byId = resolveManualOccupation("mechatronics-engineer", options);
    assert.ok(byId.ok && byId.selection.anzscoCode === "233999");

    const unknown = resolveManualOccupation("999999", options);
    assert.ok(!unknown.ok);
    assert.match(unknown.error, /No rubric for ANZSCO 999999/);
    const noRubric = resolveManualOccupation("263312", options);
    assert.ok(!noRubric.ok);
    assert.match(noRubric.error, /No rubric/);
    const ambiguous = resolveManualOccupation("233999", options);
    assert.ok(!ambiguous.ok);
    assert.match(ambiguous.error, /more than one rubric/);
  });

  it("reads the saved choice from the manualAnzsco FieldSource row", () => {
    assert.equal(manualSelectionFrom([]), null);
    const sel = manualSelectionFrom([
      { field: MANUAL_ANZSCO_FIELD, degreeLevel: null, finalValue: "mechanical-engineer" },
    ]);
    assert.equal(sel?.anzscoCode, "233512");
    // A level-scoped row or an unknown value is ignored.
    assert.equal(
      manualSelectionFrom([{ field: MANUAL_ANZSCO_FIELD, degreeLevel: "bachelor", finalValue: "mechanical-engineer" }]),
      null,
    );
    assert.equal(manualSelectionFrom([{ field: MANUAL_ANZSCO_FIELD, degreeLevel: null, finalValue: "nope" }]), null);
  });
});

describe("assessor-selected occupation (Gate 1 manual review)", () => {
  const mech = resolveManualOccupation("233512");
  assert.ok(mech.ok);

  it("without a choice a manual-review case is blocked (nothing scored)", () => {
    const r = assessExtractedSubjects(ENG, { qualifications: MANUAL_REVIEW });
    assert.equal(r.gate1?.result, "manual_review");
    assert.deepEqual(r.candidates ?? [], []);
    assert.equal(r.assessorSelected, undefined);
  });

  it("scores only the chosen occupation, keeps the gate as manual review and marks the result", () => {
    const r = assessExtractedSubjects(ENG, { qualifications: MANUAL_REVIEW, manualSelection: mech.selection });
    assert.equal(r.gate1?.result, "manual_review");
    assert.deepEqual(r.assessorSelected, mech.selection);
    assert.deepEqual(
      (r.candidates ?? []).map((c) => c.anzscoCode),
      ["233512"],
    );
    const c = r.candidates![0]!;
    assert.ok(c.matches.length > 0, "matched subjects are shown");
    assert.ok(Array.isArray(c.unmatched));
    assert.ok(c.missingSubjects.tier1 && c.missingSubjects.tier2);
    assert.equal(riskGateBlockReason(r), null);
  });

  it("is ignored when Gate 1 is open (normal routed run)", () => {
    const r = assessExtractedSubjects(ENG, { qualifications: OPEN, manualSelection: mech.selection });
    assert.equal(r.gate1?.result, "open");
    assert.equal(r.assessorSelected, undefined);
    assert.ok((r.candidates ?? []).length > 1);
  });
});

describe("riskGateBlockReason", () => {
  const gate = (result: Gate1Decision["result"]) => ({ result }) as Gate1Decision;
  const sel = { anzscoCode: "233512", title: "Mechanical Engineer", occupationId: "mechanical-engineer" };
  it("open runs; manual review runs only with an assessor-selected occupation; not eligible never", () => {
    assert.equal(riskGateBlockReason({}), null);
    assert.equal(riskGateBlockReason({ gate1: gate("open") }), null);
    assert.match(riskGateBlockReason({ gate1: gate("manual_review") }) ?? "", /manual review/);
    assert.equal(riskGateBlockReason({ gate1: gate("manual_review"), assessorSelected: sel }), null);
    assert.match(riskGateBlockReason({ gate1: gate("not_eligible"), assessorSelected: sel }) ?? "", /not eligible/);
  });
});

describe("resolveSubjects savedOnly (Assessment re-run never re-extracts)", () => {
  const transcripts = [{ id: "t1", text: "Transcript text", degreeLevel: "bachelor", createdAt: new Date(0) }];
  const base = {
    caseId: "case-test",
    transcripts,
    subjectHash: "new-hash",
    previousExtraction: undefined,
    legacyHashMatches: false,
    docLevel: () => "bachelor" as const,
    useLlm: true,
    deadlineMs: Date.now() + 1_000,
  };

  it("no saved subjects: returns null instead of extracting", async () => {
    const r = await resolveSubjects({ ...base, persistedRows: [], savedHash: null, savedOnly: true });
    assert.equal(r, null);
  });

  it("stale saved subjects are scored as saved (not cached), never re-read", async () => {
    const r = await resolveSubjects({ ...base, persistedRows: ENG, savedHash: "old-hash", savedOnly: true });
    assert.ok(r);
    assert.equal(r.rows.length, ENG.length);
    assert.equal(r.extraction.source, "persisted");
    assert.equal(r.extraction.subjectHash, "old-hash");
    assert.equal(r.cacheable, false);
  });

  it("current saved subjects are used even when force is set", async () => {
    const r = await resolveSubjects({
      ...base,
      persistedRows: ENG,
      savedHash: "new-hash",
      savedOnly: true,
      force: true,
    });
    assert.ok(r);
    assert.equal(r.extraction.source, "persisted");
    assert.equal(r.cacheable, true);
  });
});
