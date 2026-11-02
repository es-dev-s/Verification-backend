import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessExtractedSubjects, lateralHashOf } from "./assessCase.js";
import { evaluateGate1, FLAG } from "./gate1.js";
import {
  answeredLateralYes,
  EMPTY_LATERAL_STATE,
  LATERAL_DEGREE_LEVEL,
  LATERAL_FIELD,
  creditEntriesOf,
  decideLateralEntry,
  lateralEntryConfirmed,
  lateralEntryDecided,
  lateralStateColumns,
  lateralStateOf,
  priorStudyDocumentIds,
  priorStudyMatches,
  priorStudyReadPlan,
  priorStudyRowsFor,
  startPeriodOf,
  withAnswer,
  withoutPriorDocument,
  type LateralEntryState,
} from "./lateralEntry.js";
import { flattenRubricSubjects, listVocationalOccupations, loadRubric } from "./loadRubric.js";
import { matchOptionsForRubric, matchSubjectsSync } from "./matchSubjects.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import { entryStatusGrade, subjectNameToExtractedRow, type ExtractedSubjectRow, type QualificationType } from "./schemas.js";
import { lateralEntryForCase } from "./transcriptData.js";

const voc = listVocationalOccupations();
const AT = "2026-11-01T00:00:00.000Z";

function sub(
  name: string,
  yearOrSemester: string | null = null,
  grade: string | null = null,
  qualification: QualificationType = "bachelor",
): ExtractedSubjectRow {
  return { name, code: null, credits: null, grade, yearOrSemester, qualification, sourceSnippet: null, isRepeat: false };
}

const ENG = [
  "Engineering Mathematics I",
  "Engineering Physics",
  "Engineering Mechanics",
  "Engineering Drawing",
  "Thermodynamics",
  "Fluid Mechanics",
  "Strength of Materials",
  "Machine Design",
  "Heat Transfer",
  "Manufacturing Processes",
  "Control Systems",
  "Final Year Project",
];
const engRows = () => ENG.map((n) => sub(n));

const state = (patch: Partial<LateralEntryState> = {}): LateralEntryState => ({ ...EMPTY_LATERAL_STATE, ...patch });
const ans = (value: "yes" | "no") => ({ value, at: AT });
const NO_CREDIT = { rows: 0, noted: false };

function decide(over: Partial<Parameters<typeof decideLateralEntry>[0]> = {}) {
  return decideLateralEntry({
    durationYears: 3,
    startPeriod: null,
    credit: NO_CREDIT,
    state: state(),
    priorSubjectsRead: false,
    ...over,
  });
}

describe("lateral entry: routes", () => {
  it("Route 1: four years or longer, no question", () => {
    const d = decide({ durationYears: 4 });
    assert.equal(d.route, 1);
    assert.equal(d.step, "done");
  });

  it("Route 4: duration missing → manual review", () => {
    for (const durationYears of [null, 0]) {
      const d = decide({ durationYears });
      assert.equal(d.route, 4);
      assert.match(d.reason, /manual review/);
    }
  });

  it("under four years asks the question", () => {
    const d = decide({ durationYears: 3.5 });
    assert.equal(d.route, null);
    assert.equal(d.step, "ask");
  });

  it("Route 2: No without a contradiction", () => {
    const d = decide({ state: state({ answer: ans("no") }) });
    assert.equal(d.route, 2);
    assert.equal(d.flagged, false);
    assert.match(d.reason, /3-year programme/);
  });

  it("Yes asks for the earlier transcript, then Route 3 once its subjects are read", () => {
    const upload = decide({ state: state({ answer: ans("yes") }) });
    assert.equal(upload.route, null);
    assert.equal(upload.step, "upload");
    const read = decide({ state: state({ answer: ans("yes") }), priorSubjectsRead: true });
    assert.equal(read.route, 3);
    assert.equal(read.step, "done");
  });
});

describe("lateral entry: contradiction and re-confirmation", () => {
  const later = { index: 3, label: "Year 2 Semester 1" };

  it("a later start period asks once more", () => {
    const d = decide({ startPeriod: later, state: state({ answer: ans("no") }) });
    assert.equal(d.step, "reconfirm");
    assert.deepEqual(d.contradiction.reasons, ["the transcript starts at Year 2 Semester 1"]);
  });

  it("a single credited row is a contradiction", () => {
    const d = decide({ credit: { rows: 1, noted: false }, state: state({ answer: ans("no") }) });
    assert.equal(d.step, "reconfirm");
    assert.deepEqual(d.contradiction.reasons, ["1 credited or exempt subject"]);
  });

  it("still No → Route 2 flagged with the reason", () => {
    const d = decide({ startPeriod: later, state: state({ answer: ans("no"), confirm: ans("no") }) });
    assert.equal(d.route, 2);
    assert.equal(d.flagged, true);
    assert.match(d.reason, /flagged: the transcript starts at Year 2 Semester 1/);
  });

  it("Yes on re-confirmation → upload", () => {
    const d = decide({ startPeriod: later, state: state({ answer: ans("no"), confirm: ans("yes") }) });
    assert.equal(d.step, "upload");
  });

  it("start period: semester 1 and calendar-only transcripts are no contradiction", () => {
    assert.equal(startPeriodOf([sub("A", "Year 1 Semester 1"), sub("B", "Year 2 Semester 2")])?.index, 1);
    assert.equal(startPeriodOf([sub("A", "Fall 2019"), sub("B", "2020")]), null);
    assert.equal(startPeriodOf([sub("A", "Semester III"), sub("B", "Semester IV")])?.index, 3);
  });

  it("credit entries: grade, name and transcript note", () => {
    assert.equal(creditEntriesOf([sub("Calculus", null, "CT"), sub("Physics", null, "Exempt"), sub("Chemistry", null, "A")]).rows, 2);
    assert.equal(creditEntriesOf([sub("Physics", null, "Credit transfer")]).rows, 1);
    assert.equal(creditEntriesOf([sub("Physics", null, "B+")]).rows, 0);
    assert.equal(creditEntriesOf([], ["Advanced standing granted for 8 subjects"]).noted, true);
  });
});

describe("lateral entry: stored state", () => {
  it("round-trips through FieldSource columns", () => {
    let s = withAnswer(state(), "answer", "no", AT);
    s = withAnswer(s, "confirm", "no", AT);
    s = { ...s, priorDocumentIds: ["doc1"] };
    const cols = lateralStateColumns(s);
    const back = lateralStateOf([
      { field: LATERAL_FIELD, degreeLevel: LATERAL_DEGREE_LEVEL, ...cols },
    ]);
    assert.equal(back.answer?.value, "no");
    assert.equal(back.confirm?.value, "no");
    assert.deepEqual(back.priorDocumentIds, ["doc1"]);
    assert.equal(back.events.length, 2);
    assert.deepEqual([...priorStudyDocumentIds([{ field: LATERAL_FIELD, degreeLevel: "bachelor", ...cols }])], ["doc1"]);
  });

  it("changing the first answer clears the re-confirmation", () => {
    let s = withAnswer(state(), "answer", "no", AT);
    s = withAnswer(s, "confirm", "no", AT);
    s = withAnswer(s, "answer", "yes", AT);
    assert.equal(s.confirm, null);
    assert.equal(s.answer?.value, "yes");
  });

  it("missing row → empty state", () => {
    assert.deepEqual(lateralStateOf([]), EMPTY_LATERAL_STATE);
  });
});

describe("lateral entry: case view", () => {
  const bachelor = (durationYears: number | null, title = "Bachelor of Engineering"): QualificationInfo => ({
    level: "bachelor",
    rawLevel: "bachelor",
    title,
    countedYearsOverride: durationYears,
  });

  it("asks only for a bachelor under four years", () => {
    const short = lateralEntryForCase({ infos: [bachelor(3)], rows: engRows(), fieldSources: [] });
    assert.equal(short?.step, "ask");
    assert.equal(short?.durationYears, 3);
    const long = lateralEntryForCase({ infos: [bachelor(4)], rows: engRows(), fieldSources: [] });
    assert.equal(long?.route, 1);
    const diploma = lateralEntryForCase({
      infos: [{ level: "diploma", rawLevel: "diploma", title: "Diploma of Engineering", countedYearsOverride: 2 }],
      rows: [],
      fieldSources: [],
    });
    assert.equal(diploma, null);
  });

  it("Route 3 needs every uploaded transcript read", () => {
    const prior = [sub("Engineering Chemistry", null, null, "diploma")];
    const s = state({
      answer: ans("yes"),
      priorDocumentIds: ["p1", "p2"],
      priorSubjects: { documentIds: ["p1"], rows: prior, at: AT },
    });
    const cols = lateralStateColumns(s);
    const fs = [{ field: LATERAL_FIELD, degreeLevel: "bachelor", ...cols }];
    const pending = lateralEntryForCase({ infos: [bachelor(3)], rows: engRows(), fieldSources: fs });
    assert.equal(pending?.step, "upload");
    assert.deepEqual(priorStudyRowsFor(pending, s), []);
    const allRead = { ...s, priorDocumentIds: ["p1"] };
    const fs2 = [{ field: LATERAL_FIELD, degreeLevel: "bachelor", ...lateralStateColumns(allRead) }];
    const view = lateralEntryForCase({ infos: [bachelor(3)], rows: engRows(), fieldSources: fs2 });
    assert.equal(view?.route, 3);
    assert.deepEqual(view?.priorSubjects, ["Engineering Chemistry"]);
    assert.equal(priorStudyRowsFor(view, allRead).length, 1);
    assert.equal(lateralEntryDecided(view), true);
  });
});

describe("lateral entry: Route 3 matching", () => {
  const rubric = loadRubric("chemical-engineer");
  const subjects = flattenRubricSubjects(rubric);
  const opts = matchOptionsForRubric(rubric);

  it("adds Foundational matches only and never displaces a primary match", () => {
    const primaryRows = [sub("Engineering Mathematics"), sub("Heat Transfer")];
    const primary = matchSubjectsSync(primaryRows, subjects, opts).matches;
    const prior = [
      sub("Engineering Mathematics II", null, null, "diploma"),
      sub("Engineering Chemistry", null, null, "diploma"),
      sub("Mass Transfer", null, null, "diploma"),
    ];
    const added = priorStudyMatches(primary, prior, subjects, opts);
    assert.ok(added.length >= 1);
    for (const m of added) {
      assert.equal(m.tier, "tier1");
      assert.equal(m.priorStudy, true);
      assert.notEqual(m.rubricSubject, "Engineering Mathematics");
    }
    assert.ok(added.some((m) => m.rubricSubject === "Engineering Chemistry"));
    assert.ok(!added.some((m) => m.rubricSubject?.startsWith("Mass Transfer")));
  });

  it("prior subjects count on the degree path in scoring", () => {
    const rows = [sub("Engineering Mathematics"), sub("Heat Transfer"), sub("Fluid Mechanics")];
    const base = assessExtractedSubjects(rows, { occupationId: "chemical-engineer" });
    const withPrior = assessExtractedSubjects(rows, {
      occupationId: "chemical-engineer",
      priorStudyRows: [sub("Engineering Chemistry", null, null, "diploma"), sub("Engineering Physics", null, null, "diploma")],
    });
    assert.ok(withPrior.foundationalMatched > base.foundationalMatched);
    assert.equal(withPrior.coreMatched, base.coreMatched);
    assert.ok(withPrior.matches.some((m) => m.priorStudy));
  });
});

describe("lateral entry: prior-study subject reads", () => {
  const p1 = { ...sub("Engineering Chemistry", null, null, "diploma"), documentId: "p1" };
  const p2 = { ...sub("Engineering Drawing", null, null, "diploma"), documentId: "p2" };
  const doc = (id: string, status = "DONE", text: string | null = "text") => ({ id, status, text });

  it("reads only a file with no subjects yet and keeps the saved ones", () => {
    const s = state({
      answer: ans("yes"),
      priorDocumentIds: ["p1", "p2"],
      priorSubjects: { documentIds: ["p1"], rows: [p1], at: AT },
    });
    const plan = priorStudyReadPlan(s, [doc("p1"), doc("p2")]);
    assert.deepEqual(plan.toRead, ["p2"]);
    assert.deepEqual(plan.keptIds, ["p1"]);
    assert.deepEqual(plan.keptRows, [p1]);
    assert.equal(plan.complete, false);
  });

  it("nothing to read once every file has subjects; waits for a file still processing", () => {
    const done = state({
      priorDocumentIds: ["p1"],
      priorSubjects: { documentIds: ["p1"], rows: [p1], at: AT },
    });
    const plan = priorStudyReadPlan(done, [doc("p1")]);
    assert.deepEqual(plan.toRead, []);
    assert.equal(plan.complete, true);
    const waiting = priorStudyReadPlan({ ...done, priorDocumentIds: ["p1", "p2"] }, [doc("p1"), doc("p2", "EXTRACTING", null)]);
    assert.deepEqual(waiting.toRead, []);
    assert.equal(waiting.pending, true);
    assert.equal(waiting.complete, false);
  });

  it("first upload: the processed file is read; a failed one is not", () => {
    const s = state({ answer: ans("yes"), priorDocumentIds: ["p1", "p2"] });
    const plan = priorStudyReadPlan(s, [doc("p1"), doc("p2", "FAILED", null)]);
    assert.deepEqual(plan.toRead, ["p1"]);
    assert.deepEqual(plan.keptRows, []);
  });

  it("removing a file keeps the other file's subjects", () => {
    const s = state({
      answer: ans("yes"),
      priorDocumentIds: ["p1", "p2"],
      priorSubjects: { documentIds: ["p1", "p2"], rows: [p1, p2], at: AT },
    });
    const next = withoutPriorDocument(s, "p2");
    assert.deepEqual(next.priorDocumentIds, ["p1"]);
    assert.deepEqual(next.priorSubjects?.documentIds, ["p1"]);
    assert.deepEqual(next.priorSubjects?.rows, [p1]);
    assert.equal(withoutPriorDocument(next, "p1").priorSubjects, null);
  });

  it("older saves without document ids are read again when a file is removed", () => {
    const legacy = { ...p1, documentId: undefined };
    const s = state({
      priorDocumentIds: ["p1", "p2"],
      priorSubjects: { documentIds: ["p1", "p2"], rows: [legacy], at: AT },
    });
    assert.equal(withoutPriorDocument(s, "p2").priorSubjects, null);
    assert.deepEqual(priorStudyReadPlan(s, [doc("p1"), doc("p2")]).keptRows, [legacy]);
  });

  it("reads only after a Yes", () => {
    assert.equal(answeredLateralYes(state({ answer: ans("no") })), false);
    assert.equal(answeredLateralYes(state({ answer: ans("yes") })), true);
    assert.equal(answeredLateralYes(state({ answer: ans("no"), confirm: ans("yes") })), true);
  });

  it("the assessment cache key changes when the prior-study subjects change", () => {
    const base = state({ answer: ans("yes"), priorDocumentIds: ["p1"] });
    const read = { ...base, priorSubjects: { documentIds: ["p1"], rows: [p1], at: AT } };
    const more = { ...base, priorSubjects: { documentIds: ["p1", "p2"], rows: [p1, p2], at: AT } };
    const k = (s: LateralEntryState) => JSON.stringify(lateralHashOf(s));
    assert.notEqual(k(base), k(read));
    assert.notEqual(k(read), k(more));
    assert.equal(k(read), k({ ...read, priorSubjects: { ...read.priorSubjects, at: "2026-11-02T00:00:00.000Z" } }));
  });

  it("manual review with an assessor-picked occupation still uses the prior subjects", () => {
    const rows = [sub("Engineering Mathematics"), sub("Heat Transfer"), sub("Fluid Mechanics")];
    const quals: QualificationInfo[] = [
      { level: "bachelor", rawLevel: "bachelor", title: "Bachelor of Engineering (Chemical)", countedYearsOverride: 2.5 },
    ];
    const manualSelection = { occupationId: "chemical-engineer", anzscoCode: "233111", title: "Chemical Engineer" };
    const prior = [sub("Engineering Chemistry", null, null, "diploma"), sub("Engineering Physics", null, null, "diploma")];
    const base = assessExtractedSubjects(rows, { qualifications: quals, manualSelection, lateralEntryDecided: true });
    const withPrior = assessExtractedSubjects(rows, {
      qualifications: quals,
      manualSelection,
      lateralEntryDecided: true,
      priorStudyRows: prior,
    });
    assert.equal(withPrior.gate1?.result, "manual_review");
    assert.equal(withPrior.assessorSelected?.anzscoCode, "233111");
    assert.ok(withPrior.foundationalMatched > base.foundationalMatched);
    assert.ok(withPrior.matches.some((m) => m.priorStudy));
  });
});

describe("lateral entry: Gate 1 flags", () => {
  const q = (title: string, durationYears = 3): QualificationInfo[] => [{ level: "bachelor", rawLevel: "bachelor", title, countedYearsOverride: durationYears }];

  it("words such as lateral entry in the title do not force a bridging review", () => {
    const title = "Bachelor of Engineering (Lateral Entry)";
    const open = evaluateGate1({ qualifications: q(title), rows: engRows(), vocational: voc });
    assert.equal(open.result, "open");
    assert.equal(open.rule, 4);
    assert.ok(!open.reason.includes(FLAG.bridging));
  });

  it("decided routes skip the credit-transfer flag", () => {
    const rows = [...engRows(), sub("Calculus I", null, "CT"), sub("Physics I", null, "Exempt")];
    const open = evaluateGate1({ qualifications: q("Bachelor of Engineering", 4), rows, vocational: voc });
    assert.ok(open.reason.includes(FLAG.creditTransfer));
    const decided = evaluateGate1({ qualifications: q("Bachelor of Engineering", 4), rows, vocational: voc, lateralEntryDecided: true });
    assert.ok(!decided.reason.includes(FLAG.creditTransfer));
  });
});

describe("lateral entry: confirmed lateral entry in Gate 1", () => {
  const mech = (years: number): QualificationInfo[] => [
    { level: "bachelor", rawLevel: "bachelor", title: "Bachelor of Engineering (Mechanical)", countedYearsOverride: years },
  ];
  const gate = (years: number, lateral: { decided?: boolean; confirmed?: boolean } = {}) =>
    evaluateGate1({
      qualifications: mech(years),
      rows: engRows(),
      vocational: voc,
      lateralEntryDecided: lateral.decided,
      lateralEntryConfirmed: lateral.confirmed,
    });
  const track = (g: ReturnType<typeof gate>, id: string) => g.tracks.find((t) => t.track === id)!;

  it("2 to under 3 years: top-up manual review unless lateral entry is confirmed", () => {
    const plain = gate(2.5);
    assert.equal(plain.result, "manual_review");
    assert.ok(plain.reason.includes("possible top-up or bridging degree"));
    const standard = gate(2.5, { decided: true });
    assert.equal(standard.result, "manual_review");
    assert.ok(standard.reason.includes("possible top-up or bridging degree"));
  });

  it("confirmed lateral entry opens the Technologist track only", () => {
    const g = gate(2.5, { decided: true, confirmed: true });
    assert.equal(g.result, "open");
    assert.equal(g.rule, 4);
    assert.ok(g.reason.includes("confirmed lateral entry"));
    assert.equal(track(g, "engineering_technologist").open, true);
    assert.ok(track(g, "engineering_technologist").reason.includes("lateral entry"));
    assert.equal(track(g, "professional_engineer").open, false);
    assert.equal(track(g, "engineering_associate").open, false);
  });

  it("other durations are unchanged by a confirmed lateral entry", () => {
    assert.equal(gate(1.5, { decided: true, confirmed: true }).result, "not_eligible");
    const three = gate(3.5, { decided: true, confirmed: true });
    assert.equal(three.result, "open");
    assert.equal(track(three, "engineering_technologist").reason, "3-year engineering bachelor.");
    assert.equal(gate(4, { decided: true, confirmed: true }).rule, 3);
  });

  it("only Route 3 counts as confirmed", () => {
    assert.equal(lateralEntryConfirmed(null), false);
    for (const route of [1, 2, 4, null] as const) {
      assert.equal(lateralEntryConfirmed({ route } as Parameters<typeof lateralEntryConfirmed>[0]), false);
    }
    assert.equal(lateralEntryConfirmed({ route: 3 } as Parameters<typeof lateralEntryConfirmed>[0]), true);
  });

  it("a confirmed 2.5-year case is scored, with the matched prior-study subjects named", () => {
    const prior = [
      sub("Engineering Chemistry", null, null, "diploma"),
      sub("Engineering Physics", null, null, "diploma"),
      sub("Basic Electrical Engineering", null, null, "diploma"),
    ];
    const rows = [sub("Thermodynamics"), sub("Fluid Mechanics"), sub("Machine Design"), sub("Heat Transfer")];
    const result = assessExtractedSubjects(rows, {
      qualifications: mech(2.5),
      lateralEntryDecided: true,
      lateralEntryConfirmed: true,
      priorStudyRows: prior,
    });
    assert.equal(result.gate1?.result, "open");
    const cands = result.candidates ?? [];
    assert.ok(cands.length > 0);
    const priorHits = cands.flatMap((c) => c.matches.filter((m) => m.priorStudy));
    assert.ok(priorHits.length > 0);
    const priorNames = new Set(prior.map((p) => p.name));
    for (const m of priorHits) {
      assert.equal(m.tier, "tier1");
      assert.ok(priorNames.has(m.transcriptName), m.transcriptName);
      assert.ok(m.rubricSubject);
      assert.equal(m.qualification, "diploma");
    }
  });
});

describe("entryStatus capture", () => {
  it("maps credited / exempt to the grade", () => {
    assert.equal(entryStatusGrade("credited"), "Credit transfer");
    assert.equal(entryStatusGrade("exempt"), "Exempt");
    assert.equal(entryStatusGrade(null), null);
    assert.equal(entryStatusGrade("null"), null);
    assert.equal(subjectNameToExtractedRow("Physics", null, { entryStatus: "credited" }).grade, "Credit transfer");
    assert.equal(subjectNameToExtractedRow("Physics").grade, null);
  });
});
