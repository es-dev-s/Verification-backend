import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capstoneApplies, assessExtractedSubjects } from "./assessCase.js";
import { associateFallbackFor, NEC_ANZSCO } from "./associateFallback.js";
import {
  listAcademicOccupations,
  listVocationalOccupations,
  loadRubric,
  overseasVariantId,
} from "./loadRubric.js";
import { qualificationOrigin } from "./origin.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import type { ExtractedSubjectRow, QualificationType } from "./schemas.js";

function row(name: string, code: string | null = null, qualification: QualificationType = "diploma"): ExtractedSubjectRow {
  return { name, code, credits: null, grade: null, yearOrSemester: null, qualification, sourceSnippet: null, isRepeat: false };
}

function qual(title: string, country: string | null, extra: Partial<QualificationInfo> = {}): QualificationInfo {
  return { level: "diploma", title, country, countedYearsOverride: 3, ...extra };
}

describe("qualificationOrigin", () => {
  it("australian: country Australia", () => {
    const o = qualificationOrigin({ qualifications: [qual("Diploma of Engineering", "Australia")] });
    assert.equal(o.origin, "australian");
    assert.match(o.reason, /Australia/);
  });

  it("australian: AU qualification code in the title, in the texts, or AU unit codes on the transcript", () => {
    assert.equal(
      qualificationOrigin({ qualifications: [qual("UEE62122 Advanced Diploma of Engineering Technology", null)] }).origin,
      "australian",
    );
    const t = qualificationOrigin({ qualifications: [qual("Advanced Diploma", "Nepal")], texts: ["Award: RII60520"] });
    assert.equal(t.origin, "australian");
    assert.match(t.reason, /RII60520/);
    const u = qualificationOrigin({ qualifications: [qual("Diploma", "India")], rows: [row("Develop detailed electrical drawings", "UEEEL0007")] });
    assert.equal(u.origin, "australian");
    assert.match(u.reason, /UEEEL0007/);
  });

  it("overseas: a non-AU country and no AU signal (overseas course codes are not AU units)", () => {
    const o = qualificationOrigin({
      qualifications: [qual("Diploma in Civil Engineering", "Nepal")],
      rows: [row("Surveying I", "CIVENG3101"), row("Engineering Mathematics", "MTH101")],
    });
    assert.equal(o.origin, "overseas");
    assert.match(o.reason, /Nepal/);
  });

  it("unknown: no country and no codes", () => {
    const o = qualificationOrigin({ qualifications: [qual("Diploma in Civil Engineering", null)], rows: [row("Surveying")] });
    assert.equal(o.origin, "unknown");
  });
});

describe("overseas variants do not duplicate ANZSCO codes", () => {
  it("variants are hidden from the academic list and code lookups", () => {
    const academic = listAcademicOccupations();
    assert.ok(!academic.some((o) => o.id.endsWith("-os")));
    assert.ok(!academic.some((o) => o.anzsco === "312211" || o.anzsco === "312311"));
    assert.equal(academic.filter((o) => o.anzsco === "312411").length, 1);
    const ids = academic.map((o) => o.id);
    assert.equal(new Set(ids).size, ids.length);
    const codes = academic.map((o) => o.anzsco).filter((c) => c !== "233999");
    assert.equal(new Set(codes).size, codes.length, "one academic rubric per ANZSCO (233999 excepted)");
  });

  it("variant ids resolve and keep the base title", () => {
    assert.equal(overseasVariantId("312211"), "civil-engineering-draftsperson-os");
    assert.equal(overseasVariantId("312311"), "electrical-engineering-draftsperson-os");
    assert.equal(overseasVariantId("312511"), null);
    const civ = loadRubric("civil-engineering-draftsperson-os");
    assert.equal(civ.anzscoCode, "312211");
    assert.equal(loadRubric("312411").occupationId, "electronic-engineering-draftsperson");
    // Vocational list stays one per code.
    const voc = listVocationalOccupations().map((o) => o.anzsco);
    assert.equal(new Set(voc).size, voc.length);
  });
});

describe("312411 Electronic Engineering Draftsperson", () => {
  it("has a required Tier 3 project gate; the capstone applies on the Associate track only when required", () => {
    const el = loadRubric("312411");
    assert.equal(el.tiers.tier3.gate?.required, true);
    assert.equal(capstoneApplies(el, "engineering_associate"), true);
    assert.equal(capstoneApplies(loadRubric("312511"), "engineering_associate"), false);
    assert.equal(capstoneApplies(loadRubric("312511"), "professional_engineer"), true);
    assert.equal(capstoneApplies(loadRubric("civil-engineering-draftsperson-os"), "engineering_associate"), false);
  });

  const ELECTRONICS = [
    "Engineering Mathematics I",
    "Applied Physics",
    "Technical Communication",
    "Computer Applications",
    "C Programming",
    "Workshop Practice",
    "Industrial Safety",
    "Entrepreneurship Development",
    "Environmental Studies",
    "PCB Design and Fabrication",
    "Electronic Devices and Circuits",
    "Microcontroller and Embedded Systems",
    "Electronic Instruments and Measurement",
    "Communication Systems",
  ];

  it("is scored when the Associate track is open, and the missing project caps verified", () => {
    const quals = [qual("Diploma in Electronics Engineering", "Nepal")];
    const withProject = assessExtractedSubjects([...ELECTRONICS, "Major Project"].map((n) => row(n)), { qualifications: quals });
    const assocTrack = withProject.gate1?.tracks.find((t) => t.track === "engineering_associate");
    assert.equal(assocTrack?.open, true);
    assert.ok(!assocTrack!.notes.some((n) => n.includes("312411")), assocTrack!.notes.join(" | "));
    const c = withProject.candidates!.find((x) => x.anzscoCode === "312411");
    assert.ok(c, "312411 scored");
    assert.notEqual(c!.confidenceScore, null);
    assert.equal(c!.capstoneApplies, true);
    assert.equal(c!.determination, "verified_no_risk");

    const noProject = assessExtractedSubjects(ELECTRONICS.map((n) => row(n)), { qualifications: quals });
    const d = noProject.candidates!.find((x) => x.anzscoCode === "312411")!;
    assert.ok(d);
    assert.notEqual(d.determination, "verified_no_risk");
  });

  it("counts toward the 312999 fallback", () => {
    const fb = associateFallbackFor({
      associateOpen: true,
      ict60220: false,
      entries: [{ anzscoCode: "312411", title: "x", confidenceScore: 80, determination: "verified_no_risk", missing: [] }],
    })!;
    assert.equal(fb.anzscoCode, NEC_ANZSCO);
    assert.equal(fb.suggested, false);
  });
});

describe("draftsperson routing (312211 / 312311)", () => {
  const CIVIL_OS = [
    "Engineering Mathematics I",
    "Engineering Physics",
    "Engineering Chemistry",
    "Engineering Mechanics",
    "Engineering Drawing",
    "Structural Analysis",
    "Concrete Technology",
    "Soil Mechanics",
    "Surveying I",
    "Hydraulics",
    "Irrigation Engineering",
    "Highway Engineering",
    "Estimating and Costing",
    "Final Year Project",
  ];
  const CIVIL = listVocationalOccupations().find((o) => o.anzsco === "312211")!;
  const civilUnits = [...CIVIL.foundationalUnits!.units, ...CIVIL.coreUnits.units].map((u) => row(u.title, u.code, "advanced_diploma"));

  it("overseas → scored on subject headings (overseas_subjects)", () => {
    const res = assessExtractedSubjects(CIVIL_OS.map((n) => row(n)), {
      qualifications: [qual("Diploma in Civil Engineering", "Nepal")],
    });
    const c = res.candidates!.find((x) => x.anzscoCode === "312211");
    assert.ok(c, "312211 scored");
    assert.equal(c!.draftspersonPath?.path, "overseas_subjects");
    assert.equal(c!.draftspersonPath?.origin, "overseas");
    assert.equal(c!.vocational ?? null, null);
    assert.equal(c!.title, "Civil Engineering Draftsperson");
    assert.equal(res.candidates!.filter((x) => x.anzscoCode === "312211").length, 1);
  });

  it("australian → unit codes only (au_unit_codes)", () => {
    const res = assessExtractedSubjects(civilUnits, {
      qualifications: [qual("Advanced Diploma of Civil Construction Design", "Australia", { level: "advanced_diploma", countedYearsOverride: 2 })],
    });
    const c = res.candidates!.find((x) => x.anzscoCode === "312211")!;
    assert.equal(c.draftspersonPath?.path, "au_unit_codes");
    assert.equal(c.vocational?.coreMatched, 44);
    assert.equal(c.vocational?.foundationalMatched, 5);
  });

  it("unknown → both scored, best kept and flagged (both_best)", () => {
    const res = assessExtractedSubjects(CIVIL_OS.map((n) => row(n)), {
      qualifications: [qual("Diploma in Civil Engineering", null)],
    });
    const c = res.candidates!.find((x) => x.anzscoCode === "312211")!;
    assert.ok(c);
    assert.equal(c.draftspersonPath?.path, "both_best");
    assert.equal(c.draftspersonPath?.origin, "unknown");
    assert.ok(c.draftspersonPath?.note);
    assert.ok(c.draftspersonPath?.alsoScored);
    assert.equal(c.draftspersonPath?.alsoScored?.path, "au_unit_codes");
    assert.ok(c.qualificationNotes?.some((n) => n === c.draftspersonPath?.note));
    assert.equal(res.candidates!.filter((x) => x.anzscoCode === "312211").length, 1);
  });
});
