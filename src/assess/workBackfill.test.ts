import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessExtractedSubjects,
  backfillCachedCandidates,
  judgeBackfill,
  rankCandidates,
  scoreAllOccupations,
  type WorkJudge,
} from "./assessCase.js";
import type { OccupationWorkJudgement } from "./experienceBoost.js";
import { assessConfig } from "./config.js";
import { ENGINEERING_TECHNOLOGIST_CODE } from "./familyAdjust.js";
import type { AnzscoCandidate, ExtractedSubjectRow } from "./schemas.js";

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

const ROWS = [
  "Engineering Mathematics I",
  "Engineering Mathematics II",
  "Engineering Physics",
  "Engineering Drawing",
  "Engineering Mechanics",
  "Strength of Materials",
  "Fluid Mechanics",
  "Thermodynamics",
  "Surveying",
  "Structural Analysis",
  "Concrete Design",
  "Soil Mechanics",
  "Hydraulics",
  "Transportation Engineering",
  "Electrical Circuits",
  "Machine Design",
  "Heat Transfer",
  "Project Management",
  "Final Year Project",
].map(sub);
const QUALS = [
  { level: "bachelor" as const, title: "Bachelor of Engineering in Electrical Engineering", countedYearsOverride: 4 },
];

const related = (anzscoCode: string): OccupationWorkJudgement => ({
  anzscoCode,
  related: true,
  matchedJobs: [{ title: "Site Engineer", employer: "Acme" } as never],
  analysis: "Related work.",
});

/** Stub judge: records what it was asked, judges everything related. */
function stubJudge(calls: string[][]): WorkJudge {
  return async (occs) => {
    calls.push(occs.map((o) => o.rubric.anzscoCode));
    return occs.map((o) => related(o.rubric.anzscoCode));
  };
}

const failJudge: WorkJudge = async () => {
  throw new Error("judge must not be called");
};

describe("backfilled card: work-experience judgement", () => {
  it("reuses a saved judgement (+4) without asking the judge", async () => {
    const all = scoreAllOccupations(ROWS, undefined, { workExperienceBoost: false, qualifications: QUALS });
    // Use the field-matched occupation so the −15 pp penalty is not in this check.
    const fill = all.find((s) => s.rubric.anzscoCode.replace(/\s+/g, "") === "233311") ?? all[0]!;
    const before = fill.scored.confidenceScore;
    const fresh = await judgeBackfill([fill], {
      saved: [related(fill.rubric.anzscoCode)],
      judge: failJudge,
    });
    assert.deepEqual(fresh, []);
    assert.equal(fill.workExperienceBoost, true);
    assert.equal(fill.workExperienceAnalysis?.related, true);
    assert.equal(fill.workExperienceAnalysis?.confidenceScoreBefore, before);
    const cap = assessConfig.academicAlignment.scoreCap;
    const after = fill.scored.confidenceScore;
    assert.equal(after, Math.round(Math.min(cap, before + 4) * 10) / 10);
    assert.ok(after <= cap);
  });

  it("asks the judge only for the occupation missing a judgement", async () => {
    const all = scoreAllOccupations(ROWS, undefined, { workExperienceBoost: false, qualifications: QUALS });
    assert.ok(all.length >= 2, "need two scored occupations");
    const [a, b] = [all[0]!, all[1]!];
    const calls: string[][] = [];
    const fresh = await judgeBackfill([a, b], {
      saved: [{ anzscoCode: a.rubric.anzscoCode, related: false, matchedJobs: [], analysis: "" }],
      judge: stubJudge(calls),
    });
    assert.deepEqual(calls, [[b.rubric.anzscoCode]]);
    assert.deepEqual(fresh.map((j) => j.anzscoCode), [b.rubric.anzscoCode]);
    assert.equal(a.workExperienceBoost, false);
    assert.equal(a.workExperienceAnalysis?.related, false);
    assert.equal(b.workExperienceBoost, true);
  });

  it("no judge and no saved judgement: card left unjudged", async () => {
    const all = scoreAllOccupations(ROWS, undefined, { workExperienceBoost: false, qualifications: QUALS });
    const fill = all[0]!;
    const before = fill.scored.confidenceScore;
    await judgeBackfill([fill], { saved: null, judge: null });
    assert.equal(fill.workExperienceAnalysis ?? null, null);
    assert.equal(fill.scored.confidenceScore, before);
  });

  it("re-ranks cards after the boost (stable on ties)", () => {
    const c = (code: string, score: number, recommended = true) =>
      ({ anzscoCode: code, title: code, confidenceScore: score, recommended, coreMatched: 0, foundationalMatched: 0 }) as AnzscoCandidate;
    const ranked = rankCandidates([c("1", 80), c("2", 60), c("3", 64), c("4", 90, false), c("5", 60)]);
    assert.deepEqual(ranked.map((r) => r.anzscoCode), ["1", "3", "2", "5", "4"]);
  });

  it("when none are recommended, sorts by score not PE-before-ET", () => {
    const c = (code: string, score: number) =>
      ({ anzscoCode: code, title: code, confidenceScore: score, recommended: false, coreMatched: 0, foundationalMatched: 0 }) as AnzscoCandidate;
    const ranked = rankCandidates(
      [c("233311", 42.5), c("233914", 44.4)],
      (code) => (code === "233311" ? 1 : 2),
    );
    assert.deepEqual(
      ranked.map((r) => r.anzscoCode),
      ["233914", "233311"],
    );
  });
});

describe("cached load: backfilled 3rd card gets the work judgement", () => {
  it("does not backfill other PE when §3 left only the matched occupation", async () => {
    const cached = assessExtractedSubjects(ROWS, { qualifications: QUALS });
    const pe = (cached.candidates ?? []).filter(
      (c) => c.anzscoCode.replace(/\s+/g, "") !== ENGINEERING_TECHNOLOGIST_CODE,
    );
    assert.ok(pe.every((c) => c.anzscoCode.replace(/\s+/g, "") === "233311"));
    const added = await backfillCachedCandidates(cached, {
      rows: ROWS,
      qualifications: QUALS,
      judge: failJudge,
    });
    assert.equal(added, false);
  });
});
