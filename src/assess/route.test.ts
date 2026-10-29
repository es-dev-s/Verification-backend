import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessExtractedSubjects } from "./assessCase.js";
import { listVocationalOccupations } from "./loadRubric.js";
import {
  classifyQualification,
  findQualificationCodes,
  occupationKind,
  routeQualifications,
} from "./route.js";
import type { ExtractedSubjectRow, QualificationType } from "./schemas.js";

const voc = listVocationalOccupations();
const ELEC = voc.find((o) => o.anzsco === "312311")!;

function row(name: string, qualification: QualificationType = "bachelor"): ExtractedSubjectRow {
  return {
    name,
    code: null,
    credits: null,
    grade: null,
    yearOrSemester: null,
    qualification,
    sourceSnippet: null,
    isRepeat: false,
  };
}

describe("classifyQualification", () => {
  it("a training-package code routes to its vocational occupation", () => {
    const r = classifyQualification(
      { level: "advanced_diploma", title: "Advanced Diploma of Engineering Technology", texts: ["Qualification: UEE62122"] },
      voc,
    );
    assert.equal(r.route, "vocational");
    assert.deepEqual(r.vocationalOccupationIds, [ELEC.id]);
    assert.deepEqual(findQualificationCodes("UEE62122 Advanced Diploma"), ["UEE62122"]);
  });

  it("overseas Adv Dip / Associate Degree in Electrical Engineering Drafting/Design → 312311", () => {
    for (const title of [
      "Advanced Diploma in Electrical Engineering Drafting",
      "Associate Degree in Electrical Engineering Design",
    ]) {
      const r = classifyQualification({ level: "advanced_diploma", title }, voc);
      assert.equal(r.route, "vocational", title);
      assert.ok(r.vocationalOccupationIds.includes(ELEC.id), title);
    }
  });

  it("mechanical drafting diploma / BEngTech → draftsperson_academic", () => {
    assert.equal(
      classifyQualification({ level: "diploma", title: "Diploma of Mechanical Drafting" }, voc).route,
      "draftsperson_academic",
    );
    assert.equal(
      classifyQualification(
        { level: "bachelor", title: "Bachelor of Engineering Technology (Mechanical Design)" },
        voc,
      ).route,
      "draftsperson_academic",
    );
  });

  it("engineering bachelor / master → professional; drafting word allows 312511", () => {
    const be = classifyQualification({ level: "bachelor", title: "Bachelor of Mechanical Engineering" }, voc);
    assert.equal(be.route, "professional");
    assert.equal(be.allowsMechDraftsperson, false);
    const cad = classifyQualification(
      { level: "master", title: "Master of Engineering (Mechanical Design)" },
      voc,
    );
    assert.equal(cad.route, "professional");
    assert.equal(cad.allowsMechDraftsperson, true);
  });

  it("no title → unknown", () => {
    assert.equal(classifyQualification({ level: "bachelor", title: null }, voc).route, "unknown");
  });
});

describe("routeQualifications", () => {
  it("unknown → 'qualification not identified' label, no vocational ids", () => {
    const d = routeQualifications([{ level: "unknown", title: null }], voc);
    assert.deepEqual(d.routes, ["unknown"]);
    assert.deepEqual(d.vocationalOccupationIds, []);
  });

  it("vocational: a UEE62122 title points to 312311", () => {
    const d = routeQualifications([{ level: "advanced_diploma", title: "UEE62122 Advanced Diploma of Engineering Technology - Electrical" }], voc);
    assert.deepEqual(d.routes, ["vocational"]);
    assert.ok(d.vocationalOccupationIds.includes(ELEC.id));
    assert.equal(occupationKind("312511", "academic"), "mech_draftsperson");
  });

  it("a disabled vocational occupation gets a note", () => {
    const civil = voc.find((o) => !o.scoringEnabled && o.titleMatch.length)!;
    assert.ok(civil);
    const d = routeQualifications([{ level: "advanced_diploma", title: "Advanced Diploma of Civil Construction Design" }], voc);
    assert.ok(d.notes.some((n) => n.includes("not switched on")));
  });
});

describe("assessExtractedSubjects tracks (Gate 1)", () => {
  it("4-year engineering bachelor: PE + Technologist scored, Associate (312511 / 312311) closed", () => {
    const rows = [row("Engineering Drawing"), row("Thermodynamics"), row("Fluid Mechanics"), row("Machine Design")];
    const res = assessExtractedSubjects(rows, {
      qualifications: [{ level: "bachelor", title: "Bachelor of Mechanical Engineering", durationYears: 4 }],
    });
    assert.equal(res.gate1?.rule, 3);
    assert.ok(!res.candidates!.some((c) => c.anzscoCode === "312511"));
    assert.ok(!res.candidates!.some((c) => c.anzscoCode === "312311"));
    assert.ok(res.candidates!.every((c) => c.track === "professional_engineer" || c.track === "engineering_technologist"));
    assert.ok(res.candidates!.some((c) => c.track === "engineering_technologist"), "technologist kept in the top list");
    assert.equal(res.routing, undefined);
  });
});
