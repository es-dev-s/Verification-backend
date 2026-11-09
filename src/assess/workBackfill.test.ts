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
import { ENGINEERING_TECHNOLOGIST_CODE } from "./familyAdjust.js";
import type { AnzscoCandidate, AssessmentResult, ExtractedSubjectRow } from "./schemas.js";

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
const QUALS = [{ level: "bachelor" as const, title: "Bachelor of Engineering", countedYearsOverride: 4 }];

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
    const fill = all[4]!;
    const before = fill.scored.confidenceScore;
    const fresh = await judgeBackfill([fill], {
      saved: [related(fill.rubric.anzscoCode)],
      judge: failJudge,
    });
    assert.deepEqual(fresh, []);
    assert.equal(fill.workExperienceBoost, true);
    assert.equal(fill.workExperienceAnalysis?.related, true);
    assert.equal(fill.workExperienceAnalysis?.confidenceScoreBefore, before);
    assert.ok(fill.scored.confidenceScore > before, "boost lifts the score");
    assert.ok(fill.scored.confidenceScore - before <= 4 + 1e-9);
  });

  it("asks the judge only for the occupation missing a judgement", async () => {
    const all = scoreAllOccupations(ROWS, undefined, { workExperienceBoost: false, qualifications: QUALS });
    const [a, b] = [all[3]!, all[5]!];
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
    const fill = all[4]!;
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
});

describe("cached load: backfilled 3rd card gets the work judgement", () => {
  /** A saved result where ET took the 3rd slot and moves to Maybe Suitable. */
  function cachedWithEt(): AssessmentResult {
    const base = assessExtractedSubjects(ROWS, { qualifications: QUALS });
    const cands = (base.candidates ?? []).filter(
      (c) => c.anzscoCode.replace(/\s+/g, "") !== ENGINEERING_TECHNOLOGIST_CODE,
    );
    assert.ok(cands.length >= 2, "fixture needs two scored occupations");
    const primary = { ...cands[0]!, recommended: true, confidenceScore: 80 };
    const et = { ...cands[1]!, anzscoCode: ENGINEERING_TECHNOLOGIST_CODE, title: "Engineering Technologist", recommended: true, confidenceScore: 75 };
    const second = { ...cands[1]!, recommended: true, confidenceScore: 70 };
    return { ...base, candidates: [primary, et, second], workExperienceJudgements: undefined, familyAdjustment: undefined };
  }
  const input = { rows: ROWS, qualifications: QUALS };

  it("runs the check for the backfilled occupation only, boosts it, saves nothing", async () => {
    const cached = cachedWithEt();
    const calls: string[][] = [];
    const added = await backfillCachedCandidates(cached, { ...input, judge: stubJudge(calls) });
    assert.equal(added, true);
    assert.equal(cached.candidates!.length, 4);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.length, 1, "only the backfilled occupation is judged");
    const fill = cached.candidates!.find((c) => c.anzscoCode === calls[0]![0])!;
    assert.equal(fill.workExperienceBoost, true);
    assert.equal(fill.workExperienceAnalysis?.related, true);
    assert.ok(fill.confidenceScore > fill.workExperienceAnalysis!.confidenceScoreBefore);
    assert.equal(cached.workExperienceJudgements, undefined, "read-only load saves nothing");
  });

  it("reuses the judgement saved on the last run (no AI call)", async () => {
    const probe = cachedWithEt();
    const calls: string[][] = [];
    await backfillCachedCandidates(probe, { ...input, judge: stubJudge(calls) });
    const fillCode = calls[0]![0]!;

    const cached = cachedWithEt();
    cached.workExperienceJudgements = [related(fillCode)];
    await backfillCachedCandidates(cached, { ...input, judge: failJudge });
    const fill = cached.candidates!.find((c) => c.anzscoCode === fillCode)!;
    assert.equal(fill.workExperienceBoost, true);
    assert.equal(fill.workExperienceAnalysis?.analysis, "Related work.");
  });

  it("the boosted fill is re-ranked among the cards", async () => {
    const cached = cachedWithEt();
    const calls: string[][] = [];
    await backfillCachedCandidates(cached, { ...input, judge: stubJudge(calls) });
    const list = cached.candidates!;
    const fillIdx = list.findIndex((c) => c.anzscoCode === calls[0]![0]);
    const fill = list[fillIdx]!;
    // Every card after the boosted fill in the same track ranks no higher.
    const prof = list.filter((c) => c.anzscoCode !== ENGINEERING_TECHNOLOGIST_CODE);
    const scores = prof.map((c) => c.confidenceScore);
    assert.deepEqual(scores, [...scores].sort((x, y) => y - x));
    if (fill.confidenceScore > 70) {
      assert.ok(fillIdx < list.findIndex((c) => c.confidenceScore === 70 && c !== fill));
    }
  });
});
