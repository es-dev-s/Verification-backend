import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OccupationCheck } from "./assessCase.js";
import { assessExtractedSubjects } from "./assessCase.js";
import {
  EM_ANZSCO,
  EM_OCCUPATION_ID,
  EM_REDIRECT_MESSAGE,
  EMPTY_EM_ANSWERS,
  emAnswersSchema,
  engineeringManagerDisciplines,
  evaluateEngineeringManager,
  guessJobLevel,
  jobKey,
  parseEmAnswers,
  prerequisiteFromCheck,
  yearShortfall,
  type EmAnswers,
  type EmJobInput,
  type EmPrerequisite,
} from "./engineeringManager.js";
import { engineeringManagerForCase, type EmDeps } from "./engineeringManagerStore.js";
import {
  EM_CHECK_ONLY,
  isEngineeringManager,
  listManualOccupationOptions,
  MANUAL_ANZSCO_FIELD,
  manualSelectionFrom,
  resolveManualOccupation,
} from "./manualOccupation.js";
import type { ExtractedSubjectRow } from "./schemas.js";

const NOW = new Date(2026, 10, 1);
const MET: EmPrerequisite = {
  status: "met",
  disciplineId: "civil-engineer",
  anzscoCode: "233211",
  title: "Civil Engineer",
  detail: "Civil Engineer: Gate 1 Professional Engineer track open, subject match passes (82%).",
};
const YES: EmAnswers = {
  ...EMPTY_EM_ANSWERS,
  disciplineId: "civil-engineer",
  managerialRole: true,
  managersReport: true,
  rseApplied: true,
};

const job = (title: string, start: string, end: string): EmJobInput => ({ title, employer: "Acme", start, end });

describe("Engineering Manager: job levels", () => {
  it("guesses the level from the title", () => {
    assert.equal(guessJobLevel("Civil Engineer"), "professional");
    assert.equal(guessJobLevel("Senior Structural Engineer"), "professional");
    assert.equal(guessJobLevel("Engineering Manager"), "manager");
    assert.equal(guessJobLevel("Director of Engineering"), "manager");
    assert.equal(guessJobLevel("Head of Infrastructure"), "manager");
    assert.equal(guessJobLevel("Project Manager"), "project");
    assert.equal(guessJobLevel("Senior Project Engineer"), "project");
    assert.equal(guessJobLevel(null), "professional");
  });

  it("the assessor level overrides the guess (keyed by title, employer and start)", () => {
    const jobs = [job("Project Manager", "Jan 2015", "Dec 2019")];
    const answers = { ...YES, jobLevels: { [jobKey(jobs[0]!)]: "manager" as const } };
    const r = evaluateEngineeringManager({ jobs, answers, prerequisite: MET, now: NOW });
    assert.equal(r.jobs[0]!.suggestedLevel, "project");
    assert.equal(r.jobs[0]!.level, "manager");
    assert.equal(r.redirectSuggested, false);
  });
});

describe("Engineering Manager: outcomes", () => {
  it("qualified when all five requirements are met", () => {
    const r = evaluateEngineeringManager({
      jobs: [job("Civil Engineer", "Jan 2010", "Dec 2016"), job("Engineering Manager", "Jan 2017", "Present")],
      answers: YES,
      prerequisite: MET,
      now: NOW,
    });
    assert.equal(r.outcome, "qualified");
    assert.equal(r.years.professional, 7);
    assert.ok(r.years.manager >= 9);
    assert.equal(r.checks.length, 5);
    assert.ok(r.checks.every((c) => c.status === "met"));
    assert.deepEqual(r.missing, []);
  });

  it("not qualified lists each missing requirement with the year shortfall", () => {
    const r = evaluateEngineeringManager({
      jobs: [
        job("Civil Engineer", "Jan 2015", "Feb 2018"), // 3.2 years before management
        job("Engineering Manager", "Mar 2018", "Aug 2019"), // 1.5 years
      ],
      answers: { ...YES, rseApplied: false },
      prerequisite: { ...MET, status: "not_met", detail: "Civil Engineer: subject match does not pass (40%)." },
      now: NOW,
    });
    assert.equal(r.outcome, "not_qualified");
    assert.equal(r.years.professional, 3.2);
    assert.equal(r.years.manager, 1.5);
    assert.deepEqual(r.missing, [
      "Meets the Professional Engineer criteria",
      "Experience at professional level: 3.2 of 5 years, short by 1.8",
      "Experience at manager level: 1.5 of 2 years, short by 0.5",
      "RSE assessment applied",
    ]);
    assert.equal(yearShortfall(5, 5), null);
  });

  it("counts only professional years before the first manager job; overlaps once; part-time at half", () => {
    const r = evaluateEngineeringManager({
      jobs: [
        job("Design Engineer", "Jan 2010", "Dec 2014"),
        job("Design Engineer (part-time)", "Jan 2012", "Dec 2013"), // overlaps the full-time job
        job("Engineering Manager", "Jan 2013", "Dec 2016"), // professional time after 2013 is not counted
      ],
      answers: YES,
      prerequisite: MET,
      now: NOW,
    });
    // Full-time 2010-2012 (3 years) + part-time 2012 (1 year at half) = 3.5
    assert.equal(r.years.professional, 3.5);
    assert.equal(r.years.manager, 4);
    assert.equal(r.outcome, "not_qualified");
  });

  it("Project Manager / Project Engineer: suggests the redirect, the assessor confirms", () => {
    const jobs = [job("Civil Engineer", "Jan 2010", "Dec 2016"), job("Project Manager", "Jan 2017", "Present")];
    const open = evaluateEngineeringManager({ jobs, answers: YES, prerequisite: MET, now: NOW });
    assert.equal(open.redirectSuggested, true);
    assert.equal(open.outcome, "pending");
    const redirect = evaluateEngineeringManager({
      jobs,
      answers: { ...YES, redirectConfirmed: true },
      prerequisite: MET,
      now: NOW,
    });
    assert.equal(redirect.outcome, "redirect");
    assert.equal(redirect.message, EM_REDIRECT_MESSAGE);
    assert.match(redirect.message, /Professional Engineer category, Skill Level 1/);
    const declined = evaluateEngineeringManager({
      jobs,
      answers: { ...YES, redirectConfirmed: false },
      prerequisite: MET,
      now: NOW,
    });
    assert.equal(declined.outcome, "not_qualified");
  });

  it("pending until the discipline and the three confirmations are answered", () => {
    const r = evaluateEngineeringManager({
      jobs: [job("Civil Engineer", "Jan 2010", "Dec 2016"), job("Engineering Manager", "Jan 2017", "Present")],
      answers: EMPTY_EM_ANSWERS,
      prerequisite: prerequisiteFromCheck(null, null),
      now: NOW,
    });
    assert.equal(r.outcome, "pending");
    assert.deepEqual(
      r.checks.filter((c) => c.status === "pending").map((c) => c.id),
      ["professional_engineer", "managerial_role", "managers_report", "rse_applied"],
    );
  });
});

describe("Engineering Manager: Professional Engineer prerequisite", () => {
  const civil = engineeringManagerDisciplines().find((d) => d.anzscoCode === "233211")!;
  const fakeCheck = (over: Partial<OccupationCheck>, recommended: boolean): OccupationCheck =>
    ({
      track: "professional_engineer",
      trackLabel: "Professional Engineer",
      trackOpen: true,
      gateResult: "open",
      candidate: { recommended, confidenceScore: 80 },
      ...over,
    }) as unknown as OccupationCheck;

  it("lists Professional Engineer disciplines only (never 133211 itself)", () => {
    const list = engineeringManagerDisciplines();
    assert.ok(civil, "Civil Engineer is a discipline");
    assert.ok(list.every((d) => d.anzscoCode !== EM_ANZSCO));
    assert.ok(!list.some((d) => d.anzscoCode.startsWith("3")), "no associate / technologist codes");
  });

  it("needs the track open and the subject match to pass", () => {
    assert.equal(prerequisiteFromCheck(civil, fakeCheck({}, true)).status, "met");
    assert.equal(prerequisiteFromCheck(civil, fakeCheck({}, false)).status, "not_met");
    assert.equal(prerequisiteFromCheck(civil, fakeCheck({ trackOpen: false }, true)).status, "not_met");
    assert.equal(prerequisiteFromCheck(civil, null).status, "not_met");
  });

  it("the case check runs the unchanged discipline check with the saved answers", async () => {
    const calls: string[] = [];
    const deps: EmDeps = {
      load: (async () => ({
        id: "c1",
        experienceRows: [
          { title: "Civil Engineer", employer: "A", start: "Jan 2010", end: "Dec 2016" },
          { title: "Engineering Manager", employer: "B", start: "Jan 2017", end: "Present" },
        ],
        fieldSources: [{ finalValue: JSON.stringify(YES) }],
      })) as unknown as EmDeps["load"],
      check: async (_caseId, occupationId) => {
        calls.push(occupationId);
        return fakeCheck({}, true);
      },
    };
    const r = await engineeringManagerForCase("c1", undefined, deps);
    assert.deepEqual(calls, ["civil-engineer"]);
    assert.equal(r.prerequisite.status, "met");
    assert.equal(r.outcome, "qualified");
    assert.equal(r.anzscoCode, EM_ANZSCO);
  });

  it("parses saved answers safely", () => {
    assert.deepEqual(parseEmAnswers(null), EMPTY_EM_ANSWERS);
    assert.deepEqual(parseEmAnswers("not json"), EMPTY_EM_ANSWERS);
    assert.equal(parseEmAnswers(JSON.stringify(YES)).rseApplied, true);
    assert.ok(!emAnswersSchema.safeParse({ jobLevels: { a: "boss" } }).success);
  });
});

describe("Engineering Manager in the manual picker", () => {
  const options = listManualOccupationOptions();

  it("is listed once, selectable, with its own flow (no 'No rubric')", () => {
    const hits = options.filter((o) => o.anzscoCode === EM_ANZSCO);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.occupationId, EM_OCCUPATION_ID);
    assert.equal(hits[0]!.flow, "engineering_manager");
    assert.equal(hits[0]!.available, true);
    assert.equal(hits[0]!.unavailableReason, null);
    assert.match(hits[0]!.title, /Engineering Manager/i);
  });

  it("resolves by code and id, but is never a saved manual-review choice", () => {
    const byCode = resolveManualOccupation(EM_ANZSCO, options);
    assert.ok(byCode.ok && isEngineeringManager(byCode.selection.occupationId));
    const byId = resolveManualOccupation(EM_OCCUPATION_ID, options);
    assert.ok(byId.ok && byId.selection.anzscoCode === EM_ANZSCO);
    assert.equal(
      manualSelectionFrom([{ field: MANUAL_ANZSCO_FIELD, degreeLevel: null, finalValue: EM_OCCUPATION_ID }]),
      null,
    );
    assert.match(EM_CHECK_ONLY, /Check an ANZSCO/);
  });
});

describe("Engineering Manager is never suggested", () => {
  const sub = (name: string): ExtractedSubjectRow => ({
    name,
    code: null,
    credits: null,
    grade: null,
    yearOrSemester: null,
    qualification: "bachelor",
    sourceSnippet: null,
    isRepeat: false,
  });
  const ENG = [
    "Engineering Mathematics I",
    "Engineering Management",
    "Project Management",
    "Engineering Economics",
    "Structural Analysis",
    "Soil Mechanics",
    "Hydraulics",
    "Construction Management",
    "Transportation Engineering",
    "Final Year Project",
  ].map(sub);

  it("an engineering degree (even with management subjects) never ranks 133211", () => {
    for (const title of ["Bachelor of Civil Engineering", "Bachelor of Engineering (Mechanical)"]) {
      const r = assessExtractedSubjects(ENG, {
        qualifications: [{ level: "bachelor", title, countedYearsOverride: 4 }],
      });
      assert.ok((r.candidates ?? []).length > 0, title);
      assert.ok(!(r.candidates ?? []).some((c) => c.anzscoCode === EM_ANZSCO), title);
    }
  });
});