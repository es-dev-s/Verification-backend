import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessExtractedSubjects } from "./assessCase.js";
import {
  applyFieldMatchPenalty,
  bachelorTitleForField,
  etOfferedForQualifications,
  FIELD_MATCH_PENALTY_PP,
  identifyDegreeField,
  keepAssociateOccupation,
  keepProfessionalEngineer,
  selectDegreeField,
  selectDiplomaField,
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
  it("Electrical field keeps only Electrical PE; remaining unmatched occupations lose 15 pp", () => {
    const sel = selFromTitle("Bachelor of Engineering in Electrical Engineering");
    assert.equal(sel.penaltyApplies, true);
    assert.equal(sel.matchedAnzsco, "233311");
    assert.equal(keepProfessionalEngineer("233311", "Electrical Engineer", sel), true);
    assert.equal(keepProfessionalEngineer("233411", "Electronics Engineer", sel), false);
    assert.equal(keepProfessionalEngineer("233512", "Mechanical Engineer", sel), false);
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

  it("Electrical bachelor: Electrical Engineer remains; other PE are filtered out; ET stays", () => {
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
    assert.equal(otherPe, undefined, "other PE occupations are removed by §3");
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

  it("§7 Software Engineering BSc → ET only", () => {
    const res = assessExtractedSubjects(ENG_ROWS, {
      qualifications: [
        { level: "bachelor", title: "Bachelor of Science in Software Engineering", countedYearsOverride: 4 },
      ],
    });
    const codes = (res.candidates ?? []).map((c) => c.anzscoCode.replace(/\s+/g, ""));
    assert.equal(res.degreeField?.fieldId, "computer_science");
    assert.ok(codes.includes(ENGINEERING_TECHNOLOGIST_CODE));
    assert.ok(codes.every((c) => c === ENGINEERING_TECHNOLOGIST_CODE), codes.join(","));
  });

  it("§7 Computer Engineering BE / B.Tech → ET only", () => {
    for (const title of [
      "Bachelor of Engineering in Computer Engineering",
      "Bachelor of Technology in Computer Engineering",
      "Bachelor of Computer Engineering",
    ]) {
      const res = assessExtractedSubjects(ENG_ROWS, {
        qualifications: [{ level: "bachelor", title, countedYearsOverride: 4 }],
      });
      const codes = (res.candidates ?? []).map((c) => c.anzscoCode.replace(/\s+/g, ""));
      assert.equal(res.degreeField?.fieldId, null, title);
      assert.ok(codes.includes(ENGINEERING_TECHNOLOGIST_CODE), title);
      assert.ok(codes.every((c) => c === ENGINEERING_TECHNOLOGIST_CODE), `${title}: ${codes.join(",")}`);
    }
  });

  it("§7 Bachelor of Engineering in Computer Science → ET only", () => {
    const res = assessExtractedSubjects(ENG_ROWS, {
      qualifications: [
        { level: "bachelor", title: "Bachelor of Engineering in Computer Science", countedYearsOverride: 4 },
      ],
    });
    const codes = (res.candidates ?? []).map((c) => c.anzscoCode.replace(/\s+/g, ""));
    assert.equal(res.degreeField?.fieldId, "computer_science");
    assert.ok(codes.includes(ENGINEERING_TECHNOLOGIST_CODE));
    assert.ok(codes.every((c) => c === ENGINEERING_TECHNOLOGIST_CODE), codes.join(","));
  });

  it("§7 Bachelor of Information Technology → ET only", () => {
    const res = assessExtractedSubjects(ENG_ROWS, {
      qualifications: [{ level: "bachelor", title: "Bachelor of Information Technology", countedYearsOverride: 4 }],
    });
    const codes = (res.candidates ?? []).map((c) => c.anzscoCode.replace(/\s+/g, ""));
    assert.equal(res.degreeField?.fieldId, "information_technology");
    assert.ok(codes.includes(ENGINEERING_TECHNOLOGIST_CODE));
    assert.ok(codes.every((c) => c === ENGINEERING_TECHNOLOGIST_CODE), codes.join(","));
  });

  it("§7 Electronics BE → Electronics Engineer listed, ET still listed, other PE gone", () => {
    const res = assessExtractedSubjects(ENG_ROWS, {
      qualifications: [
        { level: "bachelor", title: "Bachelor of Engineering in Electronics", countedYearsOverride: 4 },
      ],
    });
    const pe = (res.candidates ?? []).filter((c) => c.track === "professional_engineer");
    const et = (res.candidates ?? []).find((c) => c.anzscoCode.replace(/\s+/g, "") === ENGINEERING_TECHNOLOGIST_CODE);
    assert.equal(res.degreeField?.fieldId, "electronic");
    assert.ok(et, "ET stays in the list");
    assert.ok(pe.some((c) => c.anzscoCode.replace(/\s+/g, "") === "233411"));
    assert.ok(pe.every((c) => c.anzscoCode.replace(/\s+/g, "") === "233411"));
  });

  it("§7 Electrical BE → Electrical Engineer listed, ET still listed", () => {
    const res = assessExtractedSubjects(ENG_ROWS, {
      qualifications: [
        { level: "bachelor", title: "Bachelor of Engineering in Electrical Engineering", countedYearsOverride: 4 },
      ],
    });
    const pe = (res.candidates ?? []).filter((c) => c.track === "professional_engineer");
    assert.ok(pe.some((c) => c.anzscoCode.replace(/\s+/g, "") === "233311"));
    assert.ok(pe.every((c) => c.anzscoCode.replace(/\s+/g, "") === "233311"));
    assert.ok((res.candidates ?? []).some((c) => c.anzscoCode.replace(/\s+/g, "") === ENGINEERING_TECHNOLOGIST_CODE));
    const noneRecommended = (res.candidates ?? []).every((c) => !c.recommended);
    if (noneRecommended) {
      const scores = (res.candidates ?? []).map((c) => c.confidenceScore);
      const sorted = [...scores].sort((a, b) => b - a);
      assert.deepEqual(scores, sorted, "unrecommended list is score-descending");
    }
  });

  it("§7 Civil BE → Civil Engineer listed, ET still listed", () => {
    const res = assessExtractedSubjects(ENG_ROWS, {
      qualifications: [
        { level: "bachelor", title: "Bachelor of Engineering in Civil Engineering", countedYearsOverride: 4 },
      ],
    });
    const pe = (res.candidates ?? []).filter((c) => c.track === "professional_engineer");
    assert.ok(pe.some((c) => c.anzscoCode.replace(/\s+/g, "") === "233211"));
    assert.ok(pe.every((c) => c.anzscoCode.replace(/\s+/g, "") === "233211"));
    assert.ok((res.candidates ?? []).some((c) => c.anzscoCode.replace(/\s+/g, "") === ENGINEERING_TECHNOLOGIST_CODE));
  });

  it("an electrical diploma keeps Electrical Draftsperson and 312999, and drops Electronic", () => {
    const field = selectDiplomaField([
      { level: "diploma", title: "DAE Electrical Technology" },
    ]);
    assert.equal(field?.fieldId, "electrical");
    assert.equal(keepAssociateOccupation("312311", "Electrical Engineering Draftsperson", field), true);
    assert.equal(keepAssociateOccupation("312411", "Electronic Engineering Draftsperson", field), false);
    assert.equal(keepAssociateOccupation("312511", "Mechanical Engineering Draftsperson", field), false);
    assert.equal(keepAssociateOccupation("312999", "Building and Engineering Technicians nec", field), true);
    assert.equal(keepAssociateOccupation("312411", "Electronic Engineering Draftsperson", null), true);
    const res = assessExtractedSubjects(ENG_ROWS, {
      qualifications: [{ level: "diploma", rawLevel: "diploma", title: "DAE Electrical Technology", countedYearsOverride: 3 }],
    });
    const codes = (res.candidates ?? []).map((c) => c.anzscoCode.replace(/\s+/g, ""));
    assert.ok(codes.includes("312311"), codes.join(","));
    assert.ok(!codes.includes("312411"), codes.join(","));
    assert.ok(codes.every((c) => c === "312311"), codes.join(","));
    const notes = (res.candidates ?? []).flatMap((c) => c.qualificationNotes ?? []);
    assert.ok(notes.every((n) => !/field of study|−15 pp/i.test(n)));
  });

  it("§7 Diploma in Computer Engineering → associate occupations only, no ET", () => {
    const res = assessExtractedSubjects(ENG_ROWS, {
      qualifications: [
        { level: "diploma", title: "Diploma in Computer Engineering", countedYearsOverride: 2 },
      ],
    });
    const codes = (res.candidates ?? []).map((c) => c.anzscoCode.replace(/\s+/g, ""));
    assert.ok(!codes.includes(ENGINEERING_TECHNOLOGIST_CODE), codes.join(","));
    assert.ok(
      (res.candidates ?? []).every((c) => c.track === "engineering_associate"),
      (res.candidates ?? []).map((c) => `${c.anzscoCode}:${c.track}`).join(","),
    );
  });
});
