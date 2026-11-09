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
/** The first n Tier 1 Foundational units (all 17 when n is omitted). */
function foundRows(n?: number): ExtractedSubjectRow[] {
  return ELEC.foundationalUnits!.units.slice(0, n).map((u) => row(u.title, u.code));
}
/** All Foundational units plus the first n core units. */
function fullRows(n: number): ExtractedSubjectRow[] {
  return [...foundRows(), ...unitRows(n)];
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
  it("is switched on: any 24 of a 132-unit core pool, 17 Foundational units; 312211 is on, 313213 stays off", () => {
    assert.equal(ELEC.scoringEnabled, true);
    assert.equal(ELEC.coreUnits.mode, "pool");
    assert.equal(ELEC.coreUnits.total, 24);
    assert.equal(ELEC.coreUnits.units.length, 132);
    assert.deepEqual(ELEC.coreUnits.thresholds, { noRisk: 21, lowRisk: 15, medium: 9 });
    assert.equal(ELEC.foundationalUnits?.units.length, 17);
    assert.deepEqual(ELEC.foundationalUnits?.thresholds, { noRisk: 14, lowRisk: 11 });
    // UEE / BSB style, plus MEM (3 letters + 5 digits) and UETTDRIS (8 letters + 2 digits) pool units.
    assert.ok(codes.every((c) => /^[A-Z]{3,8}\d{2,5}[A-Z]?$/.test(c)), codes.join(","));
    assert.equal(new Set(codes).size, codes.length);
    const civil = listVocationalOccupations().find((x) => x.anzsco === "312211");
    assert.equal(civil?.scoringEnabled, true);
    const planner = listVocationalOccupations().find((x) => x.anzsco === "313213");
    assert.equal(planner?.scoringEnabled ?? false, false);
  });
});

describe("unit-code matching", () => {
  it("normalises codes and matches exactly", () => {
    assert.equal(normalizeUnitCode(" uee-ic 0047 "), "UEEIC0047");
    const r = score([row("Instrumentation drawings", "ueeic0047")]);
    assert.equal(r.detail.matchedCore[0]?.matchType, "exact");
  });

  it("ignores the release letter", () => {
    assert.equal(stripReleaseLetter("UEENEEE101A"), "UEENEEE101");
    const u = ELEC.coreUnits.units.find((x) => x.code === "UEEEL0007")!;
    assert.ok(u);
    const r = score([row("Develop detailed electrical drawings", "UEEEL0007A")]);
    assert.equal(r.detail.coreMatched, 1);
  });

  it("matches a superseded equivalent code from training.gov.au, with its source", () => {
    const r = score([row("Use instrumentation drawings", "UEENEEI101A")]);
    const m = r.detail.matchedCore[0]!;
    assert.equal(m.code, "UEEIC0047");
    assert.equal(m.matchType, "equivalent");
    assert.match(m.note, /superseded code UEENEEI101A/);
    assert.match(m.source ?? "", /^https:\/\/training\.gov\.au\//);
  });

  it("counts a listed typo alias as its unit and flags it", () => {
    // BSBSMB402 left the 312311 core on the updated sheet; the alias rule is checked on a copy.
    const withTypo: VocationalOccupation = {
      ...ELEC,
      coreUnits: {
        ...ELEC.coreUnits,
        units: [
          ...ELEC.coreUnits.units,
          { id: "UX", code: "BSBSMB402", title: "Plan small business finances", typoAliases: ["BSBMSB402"] },
        ],
      },
    };
    const r = score([row("Plan small business finances", "BSBMSB402")], { occupation: withTypo });
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
    const r = score([], { transcriptTexts: ["UEEIC0047 Use instrumentation drawings\r\nUEEEL0007 Develop detailed electrical drawings"] });
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
    const r = score(fullRows(24));
    assert.equal(r.detail.electiveStatus, "not_assessed");
    assert.match(r.detail.electiveNote, /^Not assessed – minimum not set/);
    assert.ok(r.detail.flags.some((f) => f.includes("Elective minimum not set")));
    assert.equal(r.scored.determination, "verified_no_risk");
    assert.equal(score(fullRows(16)).scored.determination, "verified_no_risk");
    assert.equal(score(fullRows(10)).scored.determination, "conditional");
    assert.equal(score(fullRows(5)).scored.recommended, false);
  });

  it("core pool: any 24 of the 132 count, nothing is listed as missing, extra units cap at 100%", () => {
    const tail = score([...foundRows(), ...ELEC.coreUnits.units.slice(-24).map((u) => row(u.title, u.code))]);
    assert.equal(tail.detail.coreMatched, 24);
    assert.equal(tail.detail.coreMode, "pool");
    assert.deepEqual(tail.detail.missingCore, []);
    assert.equal(tail.scored.determination, "verified_no_risk");
    const many = score(fullRows(60));
    assert.equal(many.detail.coreBand, "no_risk");
    assert.ok(many.scored.corePct <= 100);
  });

  it("Tier 1 Foundational bands 14 / 11 of 17; a flag caps verified at conditional", () => {
    const at = (n: number) => score([...foundRows(n), ...unitRows(24)]);
    assert.equal(at(17).detail.foundationalBand, "no_risk");
    assert.equal(at(14).detail.foundationalBand, "no_risk");
    assert.equal(at(13).detail.foundationalBand, "low_risk");
    assert.equal(at(11).detail.foundationalBand, "low_risk");
    assert.equal(at(14).scored.tier1Outcome, "no_risk");
    assert.equal(at(11).scored.determination, "verified_no_risk");
    const low = at(10);
    assert.equal(low.detail.foundationalBand, "flag");
    assert.equal(low.scored.tier1Outcome, "flag");
    assert.equal(low.detail.foundationalMatched, 10);
    assert.equal(low.detail.missingFoundational?.length, 7);
    assert.equal(low.scored.determination, "conditional");
    assert.ok(low.detail.flags.some((f) => /Foundational/.test(f)));
    // Foundational matches are reported as Tier 1 rows, core as Tier 2.
    assert.ok(low.matches.some((m) => m.tier === "tier1" && m.category === "expected"));
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
    const r = score(fullRows(24), { qualificationMet: false, qualificationNote: "Qualification not confirmed" });
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
    const res = assessExtractedSubjects(fullRows(22), {
      qualifications: [
        {
          level: "advanced_diploma",
          title: "Advanced Diploma of Engineering Technology - Electrical",
          texts: ["UEE62122"],
          countedYearsOverride: 2,
        },
      ],
    });
    assert.equal(res.gate1?.rule, 5);
    assert.equal(res.anzscoCode, "312311");
    assert.equal(res.determination, "verified_no_risk");
    assert.equal(res.tier1Outcome, "no_risk");
    assert.equal(res.assessmentFlow, "vocational_units");
    const c = res.candidates!.find((x) => x.anzscoCode === "312311")!;
    assert.equal(c.vocational?.coreMatched, 22);
    assert.equal(c.vocational?.coreBand, "no_risk");
    assert.equal(c.vocational?.foundationalMatched, 17);
    assert.equal(c.draftspersonPath?.path, "au_unit_codes");
    // 312511 is in the same (Associate) track; its title check caps it without a drafting title.
    const drafts = res.candidates!.find((x) => x.anzscoCode === "312511");
    if (drafts) assert.notEqual(drafts.determination, "verified_no_risk");
    assert.ok(res.candidates!.every((x) => x.track === "engineering_associate"));
  });
});

describe("312211 Civil Engineering Draftsperson (any 7 of a 44-unit core pool)", () => {
  const CIVIL = listVocationalOccupations().find((o) => o.anzsco === "312211")!;
  const civilFound = CIVIL.foundationalUnits!.units.map((u) => row(u.title, u.code));
  const civilRows = (n: number) => [
    ...civilFound,
    ...CIVIL.coreUnits.units.slice(0, n).map((u) => row(u.title, u.code)),
  ];
  const civilScore = (n: number) =>
    scoreVocational({
      occupation: CIVIL,
      rows: civilRows(n),
      workExperienceBoost: false,
      qualificationMet: true,
      qualificationNote: "ok",
    });

  it("is switched on: a pool of 44 real codes, any 7 count, bands 6 / 5 / 3", () => {
    assert.equal(CIVIL.scoringEnabled, true);
    assert.equal(CIVIL.disabledReason, null);
    assert.equal(CIVIL.coreUnits.mode, "pool");
    assert.equal(CIVIL.coreUnits.total, 7);
    assert.equal(CIVIL.coreUnits.units.length, 44);
    assert.ok(CIVIL.coreUnits.units.every((u) => Boolean(u.code)));
    assert.deepEqual(CIVIL.coreUnits.thresholds, { noRisk: 6, lowRisk: 5, medium: 3 });
    assert.ok(CIVIL.reviewFlags.some((f) => /any 7 of the 44/.test(f.message) && /6 \/ 5 \/ 3/.test(f.message)));
  });

  it("bands: 6+ no risk, 5 low, 3–4 medium, below 3 high (all 5 Foundational held)", () => {
    const cases: Array<[number, string, string]> = [
      [44, "no_risk", "verified_no_risk"],
      [7, "no_risk", "verified_no_risk"],
      [6, "no_risk", "verified_no_risk"],
      [5, "low_risk", "verified_no_risk"],
      [4, "medium_risk", "conditional"],
      [3, "medium_risk", "conditional"],
      [2, "high_risk", "not_verified"],
      [0, "high_risk", "not_verified"],
    ];
    for (const [n, band, det] of cases) {
      const r = civilScore(n);
      assert.equal(r.detail.coreMatched, n, `matched ${n}`);
      assert.equal(r.detail.coreBand, band, `band at ${n}`);
      assert.equal(r.scored.determination === "no_match" ? "not_verified" : r.scored.determination, det, `det at ${n}`);
    }
  });

  it("electives stay flagged for review (minimum not set), like 312311", () => {
    const r = civilScore(40);
    assert.equal(r.detail.electiveStatus, "not_assessed");
    assert.ok(r.detail.flags.some((f) => /Elective minimum not set/.test(f)));
  });

  it("5 Foundational units are scored as Tier 1 (bands 4 / 3); the pool lists nothing as missing", () => {
    assert.equal(CIVIL.coreUnits.mode, "pool");
    assert.equal(CIVIL.foundationalUnits?.units.length, 5);
    assert.deepEqual(CIVIL.foundationalUnits?.thresholds, { noRisk: 4, lowRisk: 3 });
    const r = civilScore(44);
    assert.equal(r.scored.foundationalExpected, 5);
    assert.equal(r.scored.foundationalMatched, 5);
    assert.equal(r.detail.coreTotal, 7);
    assert.ok(r.scored.corePct <= 100);
    assert.deepEqual(civilScore(7).detail.missingCore, []);
    const noFound = scoreVocational({
      occupation: CIVIL,
      rows: CIVIL.coreUnits.units.map((u) => row(u.title, u.code)),
      workExperienceBoost: false,
      qualificationMet: true,
      qualificationNote: "ok",
    });
    assert.equal(noFound.detail.coreMatched, 44);
    assert.equal(noFound.scored.tier1Outcome, "flag");
    assert.equal(noFound.scored.determination, "conditional");
  });

  it("RII60520 as packaged (5 core + 7 electives from the pool) → 312211 verified at 96%", () => {
    const transcript = [
      ["BSBPMG530", "Manage project scope"],
      ["BSBPMG531", "Manage project time"],
      ["BSBPMG532", "Manage project quality"],
      ["BSBPMG632", "Manage program risk"],
      ["BSBTWK502", "Manage team effectiveness"],
      ["BSBWHS616", "Apply safe design principles to control WHS risks"],
      ["RIICWD507D", "Prepare detailed geotechnical design"],
      ["RIICWD533E", "Prepare detailed design of civil concrete structures"],
      ["RIICWD535E", "Prepare detailed design of civil timber structures"],
      ["RIICWD601E", "Manage civil works design processes"],
      ["RIILAT402E", "Provide leadership in the supervision of diverse work teams"],
      ["RIIQUA601E", "Establish and maintain a quality system"],
    ].map(([code, name]) => ({ ...row(name!, code!), qualification: "advanced_diploma" as const }));
    const res = assessExtractedSubjects(transcript, {
      qualifications: [
        {
          level: "advanced_diploma",
          title: "Advanced Diploma of Civil Construction Design",
          texts: ["RII60520 Advanced Diploma of Civil Construction Design"],
          country: "Australia",
        },
      ],
    });
    const c = res.candidates!.find((x) => x.anzscoCode === "312211")!;
    assert.ok(c, "312211 candidate scored");
    assert.equal(c.draftspersonPath?.path, "au_unit_codes");
    assert.equal(c.vocational?.foundationalMatched, 5);
    assert.equal(c.vocational?.coreMatched, 7);
    assert.equal(c.vocational?.coreTotal, 7);
    assert.equal(c.vocational?.coreBand, "no_risk");
    assert.equal(c.determination, "verified_no_risk");
    assert.equal(c.confidenceScore, 96);
  });

  it("RII60520 with 40 core units → 312211 verified through the assessment", () => {
    const res = assessExtractedSubjects(civilRows(40), {
      qualifications: [
        {
          level: "advanced_diploma",
          title: "Advanced Diploma of Civil Construction Design",
          texts: ["RII60520"],
          countedYearsOverride: 2,
        },
      ],
    });
    const c = res.candidates!.find((x) => x.anzscoCode === "312211");
    assert.ok(c, "312211 candidate scored");
    assert.equal(c!.vocational?.coreMatched, 40);
    assert.equal(c!.vocational?.coreBand, "no_risk");
    assert.equal(c!.determination, "verified_no_risk");
  });
});
