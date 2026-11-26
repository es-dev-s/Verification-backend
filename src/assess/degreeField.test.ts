import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessExtractedSubjects } from "./assessCase.js";
import {
  applyFieldMatchPenalty,
  bachelorTitleForField,
  etOfferedForQualifications,
  FIELD_MATCH_PENALTY_PP,
  identifyDegreeField,
  keepProfessionalEngineer,
  selectDegreeField,
  type DegreeFieldSelection,
} from "./degreeField.js";
import { ENGINEERING_TECHNOLOGIST_CODE } from "./familyAdjust.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import type { ExtractedSubjectRow } from "./schemas.js";

function row(name: string): ExtractedSubjectRow {
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

const ENG_ROWS = [
  "Engineering Mathematics I",
  "Engineering Physics",
  "Engineering Drawing",
  "Circuit Theory",
  "Power Systems",
  "Final Year Project",
].map(row);

function selFromTitle(title: string): DegreeFieldSelection {
  return selectDegreeField([{ level: "bachelor", title }]);
}

describe("identifyDegreeField (keyword order)", () => {
  it("picks specific terms before general ones", () => {
    assert.equal(identifyDegreeField("Bachelor of Geotechnical Engineering")?.id, "geotechnical");
    assert.equal(identifyDegreeField("Bachelor of Structural Engineering")?.id, "structural");
    assert.equal(identifyDegreeField("BEng Electronics")?.id, "electronic");
    assert.equal(identifyDegreeField("Bachelor of Electrical Engineering")?.id, "electrical");
    assert.equal(identifyDegreeField("Bachelor of Mechanical Engineering")?.id, "mechanical");
    assert.equal(identifyDegreeField("Bachelor of Civil Engineering")?.id, "civil");
    assert.equal(identifyDegreeField("Bachelor of Science in Software Engineering")?.id, "computer_science");
    assert.equal(identifyDegreeField("Bachelor of Engineering in Computer Science")?.id, "computer_science");
    assert.equal(identifyDegreeField("Bachelor of Information Technology")?.id, "information_technology");
  });

  it("does not treat Computer Engineering as a field", () => {
    assert.equal(identifyDegreeField("Bachelor of Engineering in Computer Engineering"), null);
    assert.equal(identifyDegreeField("Bachelor of Computer Engineering"), null);
    assert.equal(identifyDegreeField("Bachelor of Technology in Computer Engineering"), null);
  });

  it("does not match IT inside other words", () => {
    assert.equal(identifyDegreeField("Bachelor of Circuit Design"), null);
  });
});

describe("bachelor title and ET eligibility", () => {
  it("uses the bachelor title when a master is also on file", () => {
    const quals: QualificationInfo[] = [
      { level: "master", title: "Master of Engineering (Structural)" },
      { level: "bachelor", title: "Bachelor of Engineering in Electrical Engineering" },
    ];
    assert.equal(bachelorTitleForField(quals), "Bachelor of Engineering in Electrical Engineering");
    assert.equal(selectDegreeField(quals).label, "Electrical");
  });

  it("offers ET for bachelor / master / PhD, never diploma-level", () => {
    assert.equal(etOfferedForQualifications([{ level: "bachelor", title: "BSc" }]), true);
    assert.equal(etOfferedForQualifications([{ level: "master", title: "MEng" }]), true);
    assert.equal(etOfferedForQualifications([{ rawLevel: "phd", level: "unknown", title: "PhD" }]), true);
    assert.equal(etOfferedForQualifications([{ level: "diploma", title: "Diploma of Computer Engineering" }]), false);
    assert.equal(
      etOfferedForQualifications([{ level: "advanced_diploma", title: "Advanced Diploma in Software Engineering" }]),
      false,
    );
  });
});

describe("keepProfessionalEngineer + 15% penalty", () => {
  it("Electrical field keeps all PE and penalises everyone except Electrical and ET", () => {
    const sel = selFromTitle("Bachelor of Engineering in Electrical Engineering");
    assert.equal(sel.penaltyApplies, true);
    assert.equal(sel.matchedAnzsco, "233311");
    assert.equal(keepProfessionalEngineer("233311", "Electrical Engineer", sel), true);
    assert.equal(keepProfessionalEngineer("233411", "Electronics Engineer", sel), true);
    assert.equal(keepProfessionalEngineer("233512", "Mechanical Engineer", sel), true);
    const electronics = applyFieldMatchPenalty({ confidenceScore: 60 }, "233411", sel);
    const et = applyFieldMatchPenalty({ confidenceScore: 70 }, ENGINEERING_TECHNOLOGIST_CODE, sel);
    const electrical = applyFieldMatchPenalty({ confidenceScore: 82 }, "233311", sel);
    assert.equal(electronics.confidenceScore, 45);
    assert.equal(et.confidenceScore, 70);
    assert.equal(electrical.confidenceScore, 82);
    assert.equal(FIELD_MATCH_PENALTY_PP, 15);
  });

  it("Computer Engineering keeps no PE occupations", () => {
    const sel = selFromTitle("Bachelor of Engineering in Computer Engineering");
    assert.equal(sel.fieldId, null);
    assert.equal(sel.penaltyApplies, false);
    assert.equal(keepProfessionalEngineer("233311", "Electrical Engineer", sel), false);
    assert.equal(keepProfessionalEngineer("233512", "Mechanical Engineer", sel), false);
    assert.equal(keepProfessionalEngineer("233211", "Civil Engineer", sel), false);
  });

  it("Software Engineering identifies computer science and keeps no PE", () => {
    const sel = selFromTitle("Bachelor of Science in Software Engineering");
    assert.equal(sel.fieldId, "computer_science");
    assert.equal(sel.penaltyApplies, false);
    assert.equal(keepProfessionalEngineer("233411", "Electronics Engineer", sel), false);
  });
});

describe("assessExtractedSubjects (ET plus degree logic)", () => {
  it("Computer Engineering bachelor: ET in the list, no PE occupation", () => {
    const res = assessExtractedSubjects(ENG_ROWS, {
      qualifications: [
        { level: "bachelor", title: "Bachelor of Engineering in Computer Engineering", countedYearsOverride: 4 },
      ],
    });
    assert.equal(res.degreeField?.fieldId, null);
    const codes = (res.candidates ?? []).map((c) => c.anzscoCode.replace(/\s+/g, ""));
    assert.ok(codes.includes(ENGINEERING_TECHNOLOGIST_CODE), `ET missing: ${codes.join(",")}`);
    assert.ok(
      codes.every((c) => c === ENGINEERING_TECHNOLOGIST_CODE),
      `unexpected PE still ranked: ${codes.join(",")}`,
    );
  });

  it("Electrical bachelor: Electrical Engineer is not penalised; other PE lose 15 pp", () => {
    const res = assessExtractedSubjects(ENG_ROWS, {
      qualifications: [
        { level: "bachelor", title: "Bachelor of Engineering in Electrical Engineering", countedYearsOverride: 4 },
      ],
    });
    assert.equal(res.degreeField?.matchedAnzsco, "233311");
    const electrical = res.candidates?.find((c) => c.anzscoCode.replace(/\s+/g, "") === "233311");
    const otherPe = (res.candidates ?? []).find(
      (c) =>
        c.track === "professional_engineer" && c.anzscoCode.replace(/\s+/g, "") !== "233311",
    );
    const et = res.candidates?.find(
      (c) => c.anzscoCode.replace(/\s+/g, "") === ENGINEERING_TECHNOLOGIST_CODE,
    );
    assert.ok(electrical, "Electrical Engineer should remain");
    assert.ok(et, "ET stays in the list");
    if (otherPe) {
      assert.ok(
        (otherPe.qualificationNotes ?? []).some((n) => /−15 pp/.test(n) || /-15 pp/.test(n)),
        otherPe.qualificationNotes?.join("; "),
      );
    }
  });

  it("Advanced Diploma: ET is not offered", () => {
    const res = assessExtractedSubjects(ENG_ROWS, {
      qualifications: [
        {
          level: "advanced_diploma",
          title: "Advanced Diploma in Software Engineering",
          countedYearsOverride: 2,
        },
      ],
    });
    assert.equal(etOfferedForQualifications(res.gate1 ? [{ level: "advanced_diploma", title: "x" }] : []), false);
    const codes = (res.candidates ?? []).map((c) => c.anzscoCode.replace(/\s+/g, ""));
    assert.ok(!codes.includes(ENGINEERING_TECHNOLOGIST_CODE), `ET should be absent: ${codes.join(",")}`);
  });
});
