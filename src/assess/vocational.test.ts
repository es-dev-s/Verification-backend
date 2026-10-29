import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessExtractedSubjects } from "./assessCase.js";
import { listVocationalOccupations, type VocationalOccupation } from "./loadRubric.js";
import { normalizeUnitCode, type ExtractedSubjectRow } from "./schemas.js";
import {
  coreBand,
  scanUnitCodes,
  scoreVocational,
  stripReleaseLetter,
  vocationalConfidenceScore,
  vocationalDetermination,
} from "./vocational.js";

const ELEC = listVocationalOccupations().find((o) => o.anzsco === "312311")!;
const TH = { noRisk: 21, lowRisk: 15, mediumRisk: 9 };

function row(name: string, code: string | null = null): ExtractedSubjectRow {
  return {
    name,
    code,
    credits: null,
    grade: null,
    yearOrSemester: null,
    qualification: "advanced_diploma",
    sourceSnippet: null,
    isRepeat: false,
  };
}

const codes = ELEC.coreUnits.units.map((u) => u.code!);
function unitRows(n: number): ExtractedSubjectRow[] {
  return ELEC.coreUnits.units.slice(0, n).map((u) => row(u.title, u.code));
}
function score(rows: ExtractedSubjectRow[], extra: Partial<Parameters<typeof scoreVocational>[0]> = {}) {
  return scoreVocational({
    occupation: ELEC,
    rows,
    workExperienceBoost: false,
    qualificationMet: true,
    qualificationNote: "ok",
    ...extra,
  });
}

describe("312311 rubric", () => {
  it("is switched on with 24 real core codes; 312211 / 313213 stay off", () => {
    assert.equal(ELEC.scoringEnabled, true);
    assert.equal(ELEC.coreUnits.units.length, 24);
    assert.ok(codes.every((c) => /^[A-Z]{3}[A-Z]{2,3}\d{3,4}[A-Z]?$/.test(c)));
    for (const a of ["312211", "313213"]) {
      const o = listVocationalOccupations().find((x) => x.anzsco === a);
      assert.equal(o?.scoringEnabled ?? false, false, a);
    }
  });
});

describe("unit-code matching", () => {
  it("normalises codes and matches exactly", () => {
    assert.equal(normalizeUnitCode(" uee-cd 0007 "), "UEECD0007");
    const r = score([row("WHS", "ueecd0007")]);
    assert.equal(r.detail.matchedCore[0]?.matchType, "exact");
  });

  it("ignores the release letter", () => {
    assert.equal(stripReleaseLetter("UEENEEE101A"), "UEENEEE101");
    const u = ELEC.coreUnits.units.find((x) => x.code === "BSBSMB401")!;
    assert.ok(u);
    const r = score([row("Legal and risk", "BSBSMB401A")]);
    // BSBSMB401A is listed as superseded (equivalent) → also counted.
    assert.equal(r.detail.coreMatched, 1);
  });

  it("matches a superseded equivalent code from training.gov.au, with its source", () => {
    const r = score([row("Apply OHS regulations", "UEENEEE101A")]);
    const m = r.detail.matchedCore[0]!;
    assert.equal(m.code, "UEECD0007");
    assert.equal(m.matchType, "equivalent");
    assert.match(m.note, /superseded code UEENEEE101A/);
    assert.match(m.source ?? "", /^https:\/\/training\.gov\.au\//);
  });

  it("counts the BSBMSB402 typo as BSBSMB402 and flags it", () => {
    const r = score([row("Plan small business finances", "BSBMSB402")]);
    assert.equal(r.detail.matchedCore[0]?.code, "BSBSMB402");
    assert.equal(r.detail.matchedCore[0]?.matchType, "typo");
    assert.ok(r.detail.flags.some((f) => f.includes("BSBMSB402")));
  });

  it("title-only match for a line with no code: lower confidence, flagged", () => {
    const u = ELEC.coreUnits.units[0]!;
    const r = score([row(u.tgaTitle ?? u.title)]);
    assert.equal(r.detail.matchedCore[0]?.matchType, "title");
    assert.ok(r.detail.matchedCore[0]!.confidence < 0.9);
    assert.ok(r.detail.flags.some((f) => f.includes("title only")));
  });

  it("does not title-match a line that carries a different code", () => {
    const u = ELEC.coreUnits.units[0]!;
    const r = score([row(u.tgaTitle ?? u.title, "UEEXX9999")]);
    assert.equal(r.detail.coreMatched, 0);
    assert.deepEqual(r.detail.electivesFound.map((e) => e.code), ["UEEXX9999"]);
  });

  it("non-equivalent successors are flagged and not counted", () => {
    const r = score([row("Interval metering", "UEEEL0078")]);
    assert.equal(r.detail.coreMatched, 0);
    assert.equal(r.detail.electivesFound.length, 0);
    assert.ok(r.detail.flags.some((f) => f.includes("UEEEL0078") && f.includes("NOT as equivalent")));
  });

  it("scans codes from raw transcript text", () => {
    const hits = scanUnitCodes("UEECD0007  Apply WHS regulations   Competent\nfoo");
    assert.deepEqual(hits.map((h) => h.code), ["UEECD0007"]);
    const r = score([], { transcriptTexts: ["UEECD0007 Apply WHS\r\nUEECD0030 Prepare drawings"] });
    assert.equal(r.detail.coreMatched, 2);
  });
});

describe("bands and determination", () => {
  it("core bands 21–24 / 15–20 / 9–14 / 0–8", () => {
    assert.equal(coreBand(24, TH), "no_risk");
    assert.equal(coreBand(21, TH), "no_risk");
    assert.equal(coreBand(20, TH), "low_risk");
    assert.equal(coreBand(15, TH), "low_risk");
    assert.equal(coreBand(14, TH), "medium_risk");
    assert.equal(coreBand(9, TH), "medium_risk");
    assert.equal(coreBand(8, TH), "high_risk");
    assert.equal(coreBand(0, TH), "high_risk");
  });

  it("elective minimum unset: not assessed, flagged, core band decides", () => {
    const r = score(unitRows(24));
    assert.equal(r.detail.electiveStatus, "not_assessed");
    assert.match(r.detail.electiveNote, /^Not assessed – minimum not set/);
    assert.ok(r.detail.flags.some((f) => f.includes("Elective minimum not set")));
    assert.equal(r.scored.determination, "verified_no_risk");
    assert.equal(score(unitRows(16)).scored.determination, "verified_no_risk");
    assert.equal(score(unitRows(10)).scored.determination, "conditional");
    assert.equal(score(unitRows(5)).scored.recommended, false);
  });

  it("elective minimum set: rules decide", () => {
    const rules = ELEC.determinationRules;
    assert.equal(vocationalDetermination("no_risk", "met", rules), "verified_no_risk");
    assert.equal(vocationalDetermination("low_risk", "met", rules), "verified_no_risk");
    assert.equal(vocationalDetermination("no_risk", "not_met", rules), "conditional");
    assert.equal(vocationalDetermination("medium_risk", "met", rules), "conditional");
    assert.equal(vocationalDetermination("medium_risk", "not_met", rules), "conditional");
    assert.equal(vocationalDetermination("high_risk", "met", rules), "not_verified");
    const withMin: VocationalOccupation = { ...ELEC, electives: { ...ELEC.electives, minimumUnits: 2 } };
    const r = scoreVocational({
      occupation: withMin,
      rows: [...unitRows(24), row("Elective A", "UEEXX0001")],
      workExperienceBoost: false,
      qualificationMet: true,
      qualificationNote: "ok",
    });
    assert.equal(r.detail.electiveStatus, "not_met");
    assert.equal(r.scored.determination, "conditional");
  });

  it("qualification not confirmed caps verified at conditional with a note", () => {
    const r = score(unitRows(24), { qualificationMet: false, qualificationNote: "Qualification not confirmed" });
    assert.equal(r.scored.determination, "conditional");
    assert.equal(r.scored.qualificationCapped, true);
    assert.ok(r.scored.qualificationNotes.includes("Qualification not confirmed"));
  });

  it("confidence uses the academic bases (78 / 52 / 8)", () => {
    assert.equal(vocationalConfidenceScore("verified_no_risk", 100, false), 96);
    assert.equal(vocationalConfidenceScore("conditional", 50, false), 63);
    assert.equal(vocationalConfidenceScore("not_verified", 25, false), 17);
    assert.equal(vocationalConfidenceScore("conditional", 50, true), 67);
  });
});

describe("assessExtractedSubjects (vocational route)", () => {
  it("UEE62122 with 22 core units → 312311 verified, unit detail on the candidate", () => {
    const res = assessExtractedSubjects(unitRows(22), {
      qualifications: [
        {
          level: "advanced_diploma",
          title: "Advanced Diploma of Engineering Technology - Electrical",
          texts: ["UEE62122"],
          durationYears: 2,
        },
      ],
    });
    assert.equal(res.gate1?.rule, 5);
    assert.equal(res.anzscoCode, "312311");
    assert.equal(res.determination, "verified_no_risk");
    assert.equal(res.tier1Outcome, null);
    assert.equal(res.assessmentFlow, "vocational_units");
    const c = res.candidates!.find((x) => x.anzscoCode === "312311")!;
    assert.equal(c.vocational?.coreMatched, 22);
    assert.equal(c.vocational?.coreBand, "no_risk");
    // 312511 is in the same (Associate) track; its title check caps it without a drafting title.
    const drafts = res.candidates!.find((x) => x.anzscoCode === "312511");
    if (drafts) assert.notEqual(drafts.determination, "verified_no_risk");
    assert.ok(res.candidates!.every((x) => x.track === "engineering_associate"));
  });
});
