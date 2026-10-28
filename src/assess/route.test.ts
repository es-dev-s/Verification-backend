import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessExtractedSubjects } from "./assessCase.js";
import { listVocationalOccupations } from "./loadRubric.js";
import { DIPLOMA_ONLY_NOTE } from "./qualificationCheck.js";
import {
  classifyQualification,
  DRAFTSPERSON_CAP_NOTE,
  findQualificationCodes,
  occupationKind,
  routeOccupation,
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

describe("routeQualifications / routeOccupation", () => {
  it("unknown → score everything, with the 'not identified' note", () => {
    const d = routeQualifications([{ level: "unknown", title: null }], voc);
    assert.equal(d.scoreAll, true);
    assert.equal(d.note, "Scored as: all occupations — qualification not identified");
    assert.equal(routeOccupation(d, { id: "x", anzsco: "233512", kind: "professional" }).include, true);
    // Vocational only when the transcript lists unit codes.
    const v = { id: ELEC.id, anzsco: "312311", kind: "vocational" as const, scoringEnabled: true };
    assert.equal(routeOccupation(d, v).include, false);
    assert.equal(routeOccupation(d, v, { transcriptHasUnitCodes: true }).include, true);
  });

  it("professional: 312511 excluded without a drafting word, vocational excluded", () => {
    const d = routeQualifications([{ level: "bachelor", title: "Bachelor of Civil Engineering" }], voc);
    assert.equal(d.note, "Scored as: professional engineer — based on Bachelor of Civil Engineering");
    assert.equal(routeOccupation(d, { id: "p", anzsco: "233211", kind: "professional" }).include, true);
    assert.equal(routeOccupation(d, { id: "m", anzsco: "312511", kind: occupationKind("312511", "academic") }).include, false);
    assert.equal(
      routeOccupation(d, { id: ELEC.id, anzsco: "312311", kind: "vocational", scoringEnabled: true }, { transcriptHasUnitCodes: true }).include,
      false,
    );
  });

  it("draftsperson_academic: 312511 included, professional capped at conditional", () => {
    const d = routeQualifications([{ level: "diploma", title: "Diploma of Mechanical Drafting" }], voc);
    assert.equal(routeOccupation(d, { id: "m", anzsco: "312511", kind: "mech_draftsperson" }).include, true);
    const p = routeOccupation(d, { id: "p", anzsco: "233512", kind: "professional" });
    assert.deepEqual(p, { include: true, capAtConditional: true, capNote: DRAFTSPERSON_CAP_NOTE });
  });

  it("vocational: matching occupation in, professional capped as diploma, 312511 out", () => {
    const d = routeQualifications([{ level: "advanced_diploma", title: "UEE62122 Advanced Diploma of Engineering Technology - Electrical" }], voc);
    assert.deepEqual(d.routes, ["vocational"]);
    assert.equal(
      routeOccupation(d, { id: ELEC.id, anzsco: "312311", kind: "vocational", scoringEnabled: true }).include,
      true,
    );
    assert.equal(routeOccupation(d, { id: "m", anzsco: "312511", kind: "mech_draftsperson" }).include, false);
    const p = routeOccupation(d, { id: "p", anzsco: "233311", kind: "professional" });
    assert.equal(p.capAtConditional, true);
    assert.equal(p.capNote, DIPLOMA_ONLY_NOTE);
  });

  it("a disabled vocational occupation is never ranked and gets a note", () => {
    const civil = voc.find((o) => !o.scoringEnabled && o.titleMatch.length)!;
    assert.ok(civil);
    const d = routeQualifications([{ level: "advanced_diploma", title: "Advanced Diploma of Civil Construction Design" }], voc);
    assert.equal(
      routeOccupation(d, { id: civil.id, anzsco: civil.anzsco, kind: "vocational", scoringEnabled: false }).include,
      false,
    );
    assert.ok(d.notes.some((n) => n.includes("not switched on")));
  });
});

describe("assessExtractedSubjects routing", () => {
  it("professional route: 312511 is not ranked and the Scored as note is saved", () => {
    const rows = [row("Engineering Drawing"), row("Thermodynamics"), row("Fluid Mechanics"), row("Machine Design")];
    const res = assessExtractedSubjects(rows, {
      qualifications: [{ level: "bachelor", title: "Bachelor of Mechanical Engineering" }],
    });
    assert.ok(!res.candidates!.some((c) => c.anzscoCode === "312511"));
    assert.ok(!res.candidates!.some((c) => c.anzscoCode === "312311"));
    assert.equal(res.routing?.note, "Scored as: professional engineer — based on Bachelor of Mechanical Engineering");
  });
});
