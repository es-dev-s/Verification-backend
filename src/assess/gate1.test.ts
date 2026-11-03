import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessExtractedSubjects } from "./assessCase.js";
import { evidenceConfig } from "./evidenceConfig.js";
import {
  awardLevelOf,
  evaluateGate1,
  FLAG,
  matchesRecognisedHigher,
  openTracks,
  trackForAnzsco,
} from "./gate1.js";
import { listVocationalOccupations } from "./loadRubric.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import type { ExtractedSubjectRow, Gate1Decision, Gate1TrackId, QualificationType } from "./schemas.js";

const voc = listVocationalOccupations();

function sub(
  name: string,
  qualification: QualificationType = "bachelor",
  yearOrSemester: string | null = null,
  grade: string | null = null,
): ExtractedSubjectRow {
  return {
    name,
    code: null,
    credits: null,
    grade,
    yearOrSemester,
    qualification,
    sourceSnippet: null,
    isRepeat: false,
  };
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
const BUSINESS = [
  "Principles of Management",
  "Financial Accounting",
  "Business Communication",
  "Marketing Management",
  "Organisational Behaviour",
  "Business Law",
  "Human Resource Management",
  "Microeconomics",
];

const engRows = (level: QualificationType = "bachelor") => ENG.map((n) => sub(n, level));
/** ENG subjects spread over `semesters` semesters, so the duration can be counted. */
const engWithSemesters = (semesters: number, level: QualificationType = "bachelor") =>
  ENG.map((n, i) => {
    const sem = n === "Final Year Project" ? semesters : Math.min(semesters, Math.floor((i * semesters) / (ENG.length - 1)) + 1);
    return sub(n, level, `Year ${Math.ceil(sem / 2)} Semester ${sem % 2 === 0 ? 2 : 1}`);
  });

function gate(qualifications: QualificationInfo[], rows: ExtractedSubjectRow[] = [], engineeringTitledDegree?: boolean) {
  return evaluateGate1({ qualifications, rows, vocational: voc, engineeringTitledDegree });
}
const track = (g: Gate1Decision, id: Gate1TrackId) => g.tracks.find((t) => t.track === id)!;
const openIds = (g: Gate1Decision) => openTracks(g).map((t) => `${t.track}:${t.priority}`);

function assertBlocked(g: Gate1Decision) {
  assert.deepEqual(openTracks(g), []);
  for (const t of g.tracks) {
    assert.equal(t.open, false);
    assert.ok(t.reason.length > 0, `${t.track} needs a reason`);
  }
}

describe("Gate 1 config and tracks", () => {
  it("minimum years: PE 4, Technologist 3, Associate 2, under 2 not eligible", () => {
    assert.equal(evidenceConfig.gate.professionalMinYears, 4);
    assert.equal(evidenceConfig.gate.technologistMinYears, 3);
    assert.equal(evidenceConfig.gate.associateMinYears, 2);
    assert.equal(evidenceConfig.gate.notEligibleBelowYears, 2);
    assert.deepEqual(evidenceConfig.gate.recognisedHigherProgrammes, []);
  });

  it("tracks come from the ANZSCO skill-level categories", () => {
    assert.equal(trackForAnzsco("233512"), "professional_engineer");
    assert.equal(trackForAnzsco("233111"), "professional_engineer");
    assert.equal(trackForAnzsco("233914"), "engineering_technologist");
    assert.equal(trackForAnzsco("312511"), "engineering_associate");
    assert.equal(trackForAnzsco("312311"), "engineering_associate");
  });
});

describe("awardLevelOf (Honours, certificate, AQF level)", () => {
  it("reads award and AQF level", () => {
    assert.deepEqual(awardLevelOf({ level: "bachelor", title: "Bachelor of Engineering (Honours)" }), { award: "honours", aqfLevel: 8 });
    assert.deepEqual(awardLevelOf({ level: "bachelor", title: "Bachelor of Engineering" }), { award: "bachelor", aqfLevel: 7 });
    assert.deepEqual(awardLevelOf({ level: "unknown", title: "Certificate IV in Engineering" }), { award: "certificate", aqfLevel: 4 });
    assert.equal(awardLevelOf({ level: "unknown", title: "Certificate III in Engineering" }).aqfLevel, 3);
    assert.deepEqual(awardLevelOf({ level: "master", title: "Graduate Diploma of Engineering" }), { award: "graduate_diploma", aqfLevel: 8 });
    assert.deepEqual(awardLevelOf({ level: "diploma", title: "Diploma of Engineering" }), { award: "diploma", aqfLevel: 5 });
    assert.equal(awardLevelOf({ level: "advanced_diploma", title: "Advanced Diploma of Engineering" }).aqfLevel, 6);
    assert.equal(awardLevelOf({ level: "master", title: "Master of Engineering" }).aqfLevel, 9);
  });
});

describe("Rule 1: not eligible", () => {
  it("not engineering", () => {
    const g = gate([{ level: "bachelor", title: "Bachelor of Business Administration", countedYearsOverride: 4 }], BUSINESS.map((n) => sub(n)));
    assert.equal(g.result, "not_eligible");
    assert.equal(g.rule, 1);
    assert.match(g.reason, /not an engineering qualification/);
    assertBlocked(g);
  });

  it("certificate only", () => {
    const g = gate([{ level: "unknown", title: "Certificate IV in Engineering", countedYearsOverride: 1 }], engRows("unknown"));
    assert.equal(g.result, "not_eligible");
    assert.equal(g.rule, 1);
    assert.match(g.reason, /certificate/i);
    assertBlocked(g);
  });

  it("under 2 years counted / stated (Associate Degree, 1.5 years)", () => {
    const g = gate([{ level: "associate_degree", title: "Associate Degree in Engineering", countedYearsOverride: 1.5 }], engRows("associate_degree"));
    assert.equal(g.result, "not_eligible");
    assert.equal(g.rule, 1);
    assert.match(g.reason, /under 2 years/);
    assertBlocked(g);
  });

  it("Advanced Diploma under 1 year (0.5 years) → not eligible", () => {
    const g = gate([{ level: "advanced_diploma", title: "Advanced Diploma of Engineering", countedYearsOverride: 0.5 }], engRows("advanced_diploma"));
    assert.equal(g.result, "not_eligible");
    assert.equal(g.rule, 1);
    assert.match(g.reason, /under 1 year\b/);
    assertBlocked(g);
  });
});

describe("Rule 2: manual review", () => {
  it("Diploma (AQF 5)", () => {
    const g = gate([{ level: "diploma", title: "Diploma of Engineering", countedYearsOverride: 2 }], engRows("diploma"));
    assert.equal(g.result, "manual_review");
    assert.equal(g.rule, 2);
    assert.match(g.reason, /Diploma \(AQF 5\)/);
    assertBlocked(g);
  });

  it("3-year degree that may be recognised higher (config hook)", () => {
    const entry = { titlePattern: "engineering", country: "India", institution: null, note: "test programme" };
    const list = evidenceConfig.gate.recognisedHigherProgrammes as unknown as Array<typeof entry>;
    const q: QualificationInfo = { level: "bachelor", title: "Bachelor of Engineering (Civil)", countedYearsOverride: 3, country: "India" };
    assert.equal(gate([q], engRows()).rule, 4, "empty hook: technologist");
    list.push(entry);
    try {
      assert.equal(matchesRecognisedHigher(q), "test programme");
      assert.equal(matchesRecognisedHigher({ ...q, country: "Nepal" }), null);
      const g = gate([q], engRows());
      assert.equal(g.result, "manual_review");
      assert.equal(g.rule, 2);
      assert.match(g.reason, /recognised at a higher level/);
    } finally {
      list.pop();
    }
  });

  it("combined degree (3+2)", () => {
    const g = gate([{ level: "master", title: "Integrated Bachelor and Master of Technology (Mechanical Engineering)", countedYearsOverride: 5 }], engRows("master"));
    assert.equal(g.result, "manual_review");
    assert.ok(g.reason.includes(FLAG.combined));
    const t = gate([
      { level: "bachelor", title: "Bachelor of Engineering", countedYearsOverride: 3, texts: ["This is a 3+2 programme"] },
    ], engRows());
    assert.equal(t.result, "manual_review");
  });

  it("non-engineering bachelor followed by an engineering master", () => {
    const g = gate(
      [
        { level: "bachelor", title: "Bachelor of Business Administration", countedYearsOverride: 4 },
        { level: "master", title: "Master of Engineering (Mechanical)", countedYearsOverride: 2 },
      ],
      [...BUSINESS.map((n) => sub(n)), ...engRows("master")],
    );
    assert.equal(g.result, "manual_review");
    assert.match(g.reason, /non-engineering bachelor/);
  });

  it("part-time, bridging and credit-transfer study", () => {
    const pt = gate([{ level: "bachelor", title: "Bachelor of Engineering", countedYearsOverride: 4, texts: ["Mode of study: Part-time"] }], engRows());
    assert.equal(pt.result, "manual_review");
    assert.ok(pt.reason.includes(FLAG.partTime));
    const br = gate([{ level: "bachelor", title: "Bachelor of Engineering (Top-up)", countedYearsOverride: 1 }], engRows());
    // Under 2 years is checked first (rule 1); a longer top-up is manual review.
    assert.equal(br.result, "not_eligible");
    const br2 = gate([{ level: "bachelor", title: "Bachelor of Engineering (Lateral Entry)", countedYearsOverride: 3 }], engRows());
    assert.equal(br2.result, "open");
    assert.equal(br2.rule, 4);
    assert.ok(!br2.reason.includes(FLAG.bridging));
    const ct = gate(
      [{ level: "bachelor", title: "Bachelor of Engineering", countedYearsOverride: 4 }],
      [...engRows(), sub("Calculus I", "bachelor", null, "CT"), sub("Physics I", "bachelor", null, "Exempt")],
    );
    assert.equal(ct.result, "manual_review");
    assert.ok(ct.reason.includes(FLAG.creditTransfer));
    const one = gate(
      [{ level: "bachelor", title: "Bachelor of Engineering", countedYearsOverride: 4 }],
      [...engRows(), sub("Calculus I", "bachelor", null, "CT")],
    );
    assert.equal(one.rule, 3, "a single CT row is not enough");
  });

  it("the assessor's duration in Transcript data wins over the count", () => {
    const counted = gate([{ level: "bachelor", title: "Bachelor of Engineering (Mechanical)" }], engWithSemesters(6));
    assert.equal(counted.qualifications[0]!.countedYears, 3);
    const g = gate([{ level: "bachelor", title: "Bachelor of Engineering (Mechanical)", countedYearsOverride: 4 }], engWithSemesters(6));
    assert.equal(g.rule, 3);
    assert.equal(g.qualifications[0]!.countedYears, 4);
  });

  it("decision (b): engineering master with no bachelor on file → manual review, no scores", () => {
    const q: QualificationInfo = { level: "master", title: "Master of Engineering (Mechanical)", countedYearsOverride: 2 };
    const g = gate([q], engRows("master"));
    assert.equal(g.result, "manual_review");
    assert.equal(g.rule, 2);
    assert.match(g.reason, /no bachelor on file/);
    assertBlocked(g);
    const res = assessExtractedSubjects(engRows("master"), { qualifications: [q] });
    assert.equal(res.gate1?.result, "manual_review");
    assert.deepEqual(res.candidates, []);
    assert.equal(res.confidenceScore, 0);
    assert.equal(res.recommended, false);
    assert.equal(res.explanation, g.reason);
  });

  it("no qualification on file → manual review", () => {
    const g = gate([], engRows());
    assert.equal(g.result, "manual_review");
    assertBlocked(g);
  });
});

describe("Rule 3: engineering Bachelor / Honours / Master ≥ 4 years", () => {
  it("opens PE (1) and Technologist (2); Associate closed with a reason", () => {
    const g = gate([{ level: "bachelor", title: "Bachelor of Engineering (Mechanical)", countedYearsOverride: 4 }], engRows());
    assert.equal(g.result, "open");
    assert.equal(g.rule, 3);
    assert.deepEqual(openIds(g), ["professional_engineer:1", "engineering_technologist:2"]);
    assert.equal(track(g, "engineering_associate").open, false);
    assert.ok(track(g, "engineering_associate").reason);
  });

  it("Honours ≥ 4 years", () => {
    const g = gate([{ level: "bachelor", title: "Bachelor of Engineering (Honours)", countedYearsOverride: 4 }], engRows());
    assert.equal(g.rule, 3);
    assert.equal(g.qualifications[0]!.award, "honours");
  });

  it("master on top of an engineering bachelor: the bachelor decides", () => {
    const g = gate(
      [
        { level: "bachelor", title: "Bachelor of Engineering (Civil)", countedYearsOverride: 4 },
        { level: "master", title: "Master of Engineering (Structural)", countedYearsOverride: 2 },
      ],
      [...engRows(), ...engRows("master")],
    );
    assert.equal(g.rule, 3);
    assert.equal(g.qualificationUsed, "Bachelor of Engineering (Civil)");
  });

  it("3-year engineering bachelor + separate master opens Technologist", () => {
    const q: QualificationInfo[] = [
      { level: "bachelor", title: "Bachelor of Engineering (Mechanical)", countedYearsOverride: 3 },
      { level: "master", title: "Master of Engineering (Mechanical)", countedYearsOverride: 2 },
    ];
    const g = gate(q, [...engRows(), ...engRows("master")]);
    assert.equal(g.result, "open");
    assert.equal(g.rule, 4);
    assert.deepEqual(openIds(g), ["engineering_technologist:1"]);
    assert.equal(g.qualificationUsed, "Bachelor of Engineering (Mechanical)");
    const r = gate([...q].reverse(), [...engRows(), ...engRows("master")]);
    assert.equal(r.rule, 4);
    const res = assessExtractedSubjects([...engRows(), ...engRows("master")], { qualifications: q });
    assert.equal(res.gate1?.result, "open");
    assert.equal(res.gate1?.rule, 4);
    assert.ok((res.candidates ?? []).length > 0);
    for (const c of res.candidates ?? []) {
      assert.equal(c.track, "engineering_technologist", c.anzscoCode);
    }
  });

  it("3-year bachelor + separate master: counted 3 years also opens Technologist", () => {
    const g = gate(
      [
        { level: "bachelor", title: "Bachelor of Engineering (Civil)" },
        { level: "master", title: "Master of Engineering (Structural)", countedYearsOverride: 2 },
      ],
      [...engWithSemesters(6), ...engRows("master")],
    );
    assert.equal(g.result, "open");
    assert.equal(g.rule, 4);
    assert.deepEqual(openIds(g), ["engineering_technologist:1"]);
  });

  it("3-year bachelor alone stays Technologist; 4-year bachelor + master stays rule 3", () => {
    const solo = gate([{ level: "bachelor", title: "Bachelor of Engineering (Mechanical)", countedYearsOverride: 3 }], engRows());
    assert.equal(solo.rule, 4);
    const four = gate(
      [
        { level: "bachelor", title: "Bachelor of Engineering (Mechanical)", countedYearsOverride: 4 },
        { level: "master", title: "Master of Engineering (Mechanical)", countedYearsOverride: 2 },
      ],
      [...engRows(), ...engRows("master")],
    );
    assert.equal(four.rule, 3);
  });

  it("single combined 3+2 title is unchanged (combined flag, not the bachelor+master rule)", () => {
    const g = gate(
      [{ level: "master", title: "Integrated Bachelor and Master of Technology (Mechanical Engineering)", countedYearsOverride: 5 }],
      engRows("master"),
    );
    assert.equal(g.result, "manual_review");
    assert.ok(g.reason.includes(FLAG.combined));
  });

  it("a title that is not clearly engineering still follows the level rules", () => {
    const g = gate(
      [{ level: "bachelor", title: "Bachelor of Science", countedYearsOverride: 4 }],
      engRows(),
    );
    assert.equal(g.qualifications[0]!.engineering, "unclear");
    assert.equal(g.result, "open");
    assert.equal(g.rule, 3);
    assert.deepEqual(openIds(g), ["professional_engineer:1", "engineering_technologist:2"]);
  });

  it("3-year bachelor + a clearly non-engineering master stays Technologist", () => {
    const g = gate(
      [
        { level: "bachelor", title: "Bachelor of Engineering (Electrical)", countedYearsOverride: 3 },
        { level: "master", title: "Master of Business Administration", countedYearsOverride: 2 },
      ],
      [...engRows(), ...BUSINESS.map((n) => sub(n, "master"))],
    );
    assert.equal(g.rule, 4);
  });

  it("durations are never combined (Adv Dip 2 + Bachelor 3 → Technologist, not PE)", () => {
    const g = gate(
      [
        { level: "advanced_diploma", title: "Advanced Diploma of Engineering", countedYearsOverride: 2 },
        { level: "bachelor", title: "Bachelor of Engineering (Electrical)", countedYearsOverride: 3 },
      ],
      [...engRows("advanced_diploma"), ...engRows()],
    );
    assert.equal(g.rule, 4);
    assert.equal(g.qualificationUsed, "Bachelor of Engineering (Electrical)");
  });

  it("scores only open tracks and ranks PE first among recommended", () => {
    const res = assessExtractedSubjects(engRows(), {
      qualifications: [{ level: "bachelor", title: "Bachelor of Engineering (Mechanical)", countedYearsOverride: 4 }],
    });
    assert.equal(res.gate1?.rule, 3);
    for (const c of res.candidates ?? []) {
      assert.ok(c.track === "professional_engineer" || c.track === "engineering_technologist", c.anzscoCode);
    }
  });
});

describe("Rule 4: engineering bachelor 3 to under 4 years → Technologist only", () => {
  it("3-year engineering bachelor", () => {
    const g = gate([{ level: "bachelor", title: "Bachelor of Engineering Technology (Mechanical)", countedYearsOverride: 3 }], engRows());
    assert.equal(g.result, "open");
    assert.equal(g.rule, 4);
    assert.deepEqual(openIds(g), ["engineering_technologist:1"]);
    assert.match(track(g, "professional_engineer").reason, /^Below the minimum level and duration required for Professional Engineer/);
    assert.equal(track(g, "engineering_associate").open, false);
  });

  it("decision (c): 3-year engineering bachelor not titled engineering technology → Technologist", () => {
    const g = gate([{ level: "bachelor", title: "Bachelor of Engineering (Civil)", countedYearsOverride: 3 }], engRows());
    assert.equal(g.rule, 4);
    assert.deepEqual(openIds(g), ["engineering_technologist:1"]);
    const res = assessExtractedSubjects(engRows(), {
      qualifications: [{ level: "bachelor", title: "Bachelor of Engineering (Civil)", countedYearsOverride: 3 }],
    });
    assert.ok((res.candidates ?? []).every((c) => c.track === "engineering_technologist"));
  });

  it("3.5 years is still Technologist", () => {
    assert.equal(gate([{ level: "bachelor", title: "Bachelor of Engineering", countedYearsOverride: 3.5 }], engRows()).rule, 4);
  });
});

describe("Rule 5: Advanced Diploma ≥ 1 year / Associate Degree ≥ 2 years → Associate only", () => {
  it("config: Advanced Diploma minimum is 1 year, everything else keeps 2", () => {
    assert.equal(evidenceConfig.gate.advancedDiplomaMinYears, 1);
    assert.equal(evidenceConfig.gate.associateMinYears, 2);
    assert.equal(evidenceConfig.gate.notEligibleBelowYears, 2);
  });

  it("Advanced Diploma of Engineering, 1 year → Engineering Associate", () => {
    const g = gate([{ level: "advanced_diploma", title: "Advanced Diploma of Engineering (Mechanical)", countedYearsOverride: 1 }], engRows("advanced_diploma"));
    assert.equal(g.result, "open");
    assert.equal(g.rule, 5);
    assert.deepEqual(openIds(g), ["engineering_associate:1"]);
  });

  it("Advanced Diploma of Engineering, 1.5 years → Engineering Associate", () => {
    const g = gate([{ level: "advanced_diploma", title: "Advanced Diploma of Engineering", countedYearsOverride: 1.5 }], engRows("advanced_diploma"));
    assert.equal(g.result, "open");
    assert.equal(g.rule, 5);
  });

  it("Advanced Diploma of Engineering, 2 years", () => {
    const g = gate([{ level: "advanced_diploma", title: "Advanced Diploma of Engineering (Mechanical)", countedYearsOverride: 2 }], engRows("advanced_diploma"));
    assert.equal(g.result, "open");
    assert.equal(g.rule, 5);
    assert.deepEqual(openIds(g), ["engineering_associate:1"]);
    assert.match(track(g, "professional_engineer").reason, /Professional Engineer/);
    assert.match(track(g, "engineering_technologist").reason, /Engineering Technologist/);
  });

  it("Associate Degree in Engineering, 2 years", () => {
    const g = gate([{ level: "associate_degree", title: "Associate Degree in Engineering", countedYearsOverride: 2 }], engRows("associate_degree"));
    assert.equal(g.rule, 5);
  });
});

describe("duration comes only from Transcript data", () => {
  it("no years, semesters or credits and nothing entered → manual review", () => {
    const g = gate([{ level: "bachelor", title: "Bachelor of Engineering" }], engRows());
    assert.equal(g.result, "manual_review");
    assert.match(g.reason, /could not be counted from the transcript and was not entered in Transcript data/);
    assert.equal(g.qualifications[0]!.durationSource, "none");
  });

  it("nothing to count but entered by the assessor → used", () => {
    const g = gate([{ level: "bachelor", title: "Bachelor of Engineering", countedYearsOverride: 4 }], engRows());
    assert.equal(g.rule, 3);
    assert.equal(g.qualifications[0]!.durationSource, "counted");
  });

  it("counted from printed semesters when nothing is entered", () => {
    const g = gate([{ level: "bachelor", title: "Bachelor of Engineering", countedYearsOverride: null }], engWithSemesters(8));
    assert.equal(g.rule, 3);
    assert.equal(g.qualifications[0]!.countedYears, 4);
  });
});
