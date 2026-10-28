import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyBoostAndCut,
  assessExtractedSubjects,
  chooseSubjectsAfterExtraction,
  scoreAllOccupations,
} from "./assessCase.js";
import {
  dedupeSubjects,
  hashScoringInput,
  hashSubjectInput,
  stableStringify,
} from "./extractSubjects.js";
import {
  flattenRubricSubjects,
  loadRubric,
  scoringSubjects,
  synonymsFromMatchingNote,
} from "./loadRubric.js";
import { looksLikeGateSubject, matchSubjectsSync } from "./matchSubjects.js";
import {
  canonicalTokens,
  coreFromCanonical,
  ruleMatch,
} from "./normalize.js";
import type { ExtractedSubjectRow } from "./schemas.js";
import { blendedCoveragePct, computeConfidenceScore } from "./score.js";

function sub(
  name: string,
  qualification: ExtractedSubjectRow["qualification"] = "bachelor",
): ExtractedSubjectRow {
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

function probe(name: string) {
  const canon = canonicalTokens(name);
  return { canonical: canon.join(" "), core: coreFromCanonical(canon) };
}

function rule(a: string, b: string) {
  return ruleMatch(probe(a), probe(b));
}

describe("#7 rule-based subject matching", () => {
  it("matches the audit examples", () => {
    assert.ok(rule("Mathematics II", "Engineering Mathematics"));
    assert.equal(rule("Strength of Material", "Strength of Materials"), "canonical");
    assert.ok(rule("Thermodynamics", "Chemical Engineering Thermodynamics"));
    assert.equal(rule("Control Systems", "Control Engineering"), "core_equal");
    assert.equal(
      rule("Basic Electrical Engineering", "Electrical Engineering"),
      "core_equal",
    );
  });

  it("expands abbreviations and strips level suffixes", () => {
    assert.equal(rule("Engg. Maths - II", "Engineering Mathematics"), "canonical");
    assert.equal(rule("Mech. Drawing Part A", "Mechanical Drawing"), "canonical");
    assert.equal(rule("Applied Thermo 2", "Applied Thermodynamics"), "canonical");
    assert.equal(rule("Engineering Mgmt", "Engineering Management"), "canonical");
    assert.equal(rule("Elec. Machines I", "Electrical Machines"), "canonical");
  });

  it("guards against single generic word false positives", () => {
    assert.equal(rule("Communication Systems", "Communication Skills"), null);
    assert.equal(rule("Soil Mechanics", "Engineering Mechanics"), null);
    assert.equal(rule("Heat Transfer", "Mass Transfer"), null);
    assert.equal(rule("Quality Control", "Control Engineering"), null);
    assert.equal(rule("Introduction to Engineering", "Engineering Drawing"), null);
  });

  it("uses guarded containment (≥2 core words)", () => {
    assert.equal(rule("Fluid Mechanics Lab", "Fluid Mechanics"), "containment");
    assert.equal(rule("Advanced Structural Analysis", "Structural Analysis"), "containment");
  });

  it("parses rubric matchingNote synonyms", () => {
    const chem = synonymsFromMatchingNote(
      "Includes Engineering/Applied/General Chemistry variants.",
    );
    assert.ok(chem.includes("Applied Chemistry"));
    assert.ok(chem.includes("General Chemistry"));
    const maths = synonymsFromMatchingNote(
      "Includes Mathematics I/II/III, Numerical Methods, Probability & Statistics, Differential Equations, Linear Algebra, etc.",
    );
    assert.ok(maths.includes("Mathematics II"));
    assert.ok(maths.includes("Numerical Methods"));
    assert.ok(maths.includes("Linear Algebra"));
    assert.deepEqual(
      synonymsFromMatchingNote("Not used to determine suitability (context only)."),
      [],
    );
  });

  it("matches civil foundation subjects through notes / rules", () => {
    const rubric = loadRubric("civil-engineer");
    const { matches } = matchSubjectsSync(
      [sub("Numerical Methods"), sub("Mathematics II"), sub("Physics Lab")],
      flattenRubricSubjects(rubric),
    );
    const hit = (n: string) =>
      matches.find((m) => m.transcriptName === n && m.method !== "none")?.rubricSubject;
    assert.equal(hit("Numerical Methods"), "Engineering Mathematics");
    assert.equal(hit("Mathematics II"), "Engineering Mathematics");
    assert.equal(hit("Physics Lab"), "Engineering Physics");
  });
});

describe("#8 contextual 'Others' entries are not scored", () => {
  it("tier-1 scoring subjects equal the rubric denominator", () => {
    for (const id of ["civil-engineer", "mechanical-engineer", "agricultural-engineer", "biomedical-engineer"]) {
      const rubric = loadRubric(id);
      assert.equal(
        scoringSubjects(rubric, "tier1").length,
        rubric.tiers.tier1.scoreDenominator,
        id,
      );
      assert.ok(!flattenRubricSubjects(rubric).some((s) => /^others/i.test(s.name)), id);
    }
  });

  it("general electives do not add tier-1 matches", () => {
    const r = assessExtractedSubjects(
      [sub("Technical Writing"), sub("Workshop Practice"), sub("Environmental Studies")],
      { occupationId: "agricultural-engineer" },
    );
    assert.equal(r.foundationalMatched, 0);
  });
});

describe("#3 project / thesis gate", () => {
  it("recognises project-like subjects and rejects management courses", () => {
    for (const n of ["Final Year Project II", "Research Project", "Thesis", "Capstone Design Project", "Dissertation", "Project Work"]) {
      assert.equal(looksLikeGateSubject(n), true, n);
    }
    for (const n of ["Project Management", "Engineering Project Planning", "Project Appraisal and Finance", "Construction Project Control"]) {
      assert.equal(looksLikeGateSubject(n), false, n);
    }
  });

  it("meets the gate from a generic 'Project Work' subject", () => {
    const base = [
      sub("Engineering Mathematics"),
      sub("Material and Energy Balances"),
      sub("Heat Transfer"),
    ];
    const without = assessExtractedSubjects(base, { occupationId: "chemical-engineer" });
    const withGate = assessExtractedSubjects([...base, sub("Project Work")], {
      occupationId: "chemical-engineer",
    });
    assert.equal(without.tier3GateMet, false);
    assert.equal(withGate.tier3GateMet, true);
    const pm = assessExtractedSubjects([...base, sub("Project Management")], {
      occupationId: "chemical-engineer",
    });
    assert.equal(pm.tier3GateMet, false);
  });
});

describe("#2 small denominators do not dominate", () => {
  it("blended coverage favours more absolute evidence", () => {
    assert.ok(blendedCoveragePct(2, 5, 8) < blendedCoveragePct(6, 10, 8));
    assert.equal(blendedCoveragePct(8, 8, 8), 100);
    assert.equal(blendedCoveragePct(2, 5, 8, 0), 40);
  });

  it("2/5 core scores below 6/10 core at the same determination", () => {
    const common = {
      rawDetermination: "conditional" as const,
      tier3GateMet: false,
      workExperienceBoost: false,
      foundationalPct: 40,
      foundationalMatched: 2,
      foundationalExpected: 5,
    };
    const small = computeConfidenceScore({ ...common, corePct: 40, coreMatched: 2, coreExpected: 5 });
    const big = computeConfidenceScore({ ...common, corePct: 60, coreMatched: 6, coreExpected: 10 });
    assert.ok(big > small, `${big} > ${small}`);
  });
});

describe("#12 Master's considered even when Bachelor's looks fine", () => {
  const bachelor = [
    sub("Engineering Mathematics"),
    sub("Engineering Physics"),
    sub("Engineering Chemistry"),
    sub("Engineering Mechanics"),
    sub("Engineering Drawing"),
    sub("Material and Energy Balances"),
    sub("Chemical Engineering Thermodynamics"),
    sub("Fluid Mechanics"),
    sub("Heat Transfer"),
    sub("Final Year Project"),
  ];
  it("keeps the better combined pool", () => {
    const bOnly = assessExtractedSubjects(bachelor, { occupationId: "chemical-engineer" });
    const withMaster = assessExtractedSubjects(
      [
        ...bachelor,
        sub("Mass Transfer", "master"),
        sub("Chemical Reaction Engineering", "master"),
        sub("Process Dynamics and Control", "master"),
      ],
      { occupationId: "chemical-engineer" },
    );
    assert.ok(withMaster.coreMatched > bOnly.coreMatched);
    assert.equal(withMaster.mastersFallbackUsed, true);
    assert.ok(withMaster.qualificationsUsed.includes("master"));
  });

  it("prefers Bachelor's on a tie", () => {
    const r = assessExtractedSubjects(
      [...bachelor, sub("Engineering Physics", "master")],
      { occupationId: "chemical-engineer" },
    );
    assert.equal(r.mastersFallbackUsed, false);
    assert.equal(r.transcriptSource?.kind, "bachelor");
  });
});

describe("#11 dedupe per qualification", () => {
  it("keeps the same subject under different qualifications", () => {
    const rows = dedupeSubjects([
      sub("Structural Analysis"),
      sub("structural  analysis"),
      sub("Structural Analysis", "master"),
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.isRepeat, true);
    assert.equal(rows[1]!.qualification, "master");
  });
});

describe("empty-extraction guard", () => {
  const row = (name: string) => ({
    name,
    code: null,
    credits: null,
    grade: null,
    yearOrSemester: null,
    qualification: "bachelor" as const,
    sourceSnippet: null,
    isRepeat: false,
  });
  it("keeps saved subjects when extraction returns none", () => {
    const saved = [row("Thermodynamics")];
    const r = chooseSubjectsAfterExtraction([], saved);
    assert.equal(r.keptSaved, true);
    assert.deepEqual(r.rows, saved);
  });
  it("uses fresh subjects (even a partial list) when there are any", () => {
    const fresh = [row("Fluid Mechanics")];
    const r = chooseSubjectsAfterExtraction(fresh, [row("Thermodynamics"), row("Statics")]);
    assert.equal(r.keptSaved, false);
    assert.deepEqual(r.rows, fresh);
  });
  it("returns the empty list when nothing was saved", () => {
    assert.deepEqual(chooseSubjectsAfterExtraction([], []), { rows: [], keptSaved: false });
  });
});

describe("#6 cache keys", () => {
  it("scoring hash changes with experience / qualification edits", () => {
    const parts = {
      subjectHash: "s",
      cvText: "cv",
      experienceRows: [{ id: "e1", title: "Site Engineer", domainFinal: null }],
      qualifications: [{ degreeLevel: "bachelor", degreeTitle: "BE Civil" }],
      selectedDegreeLevels: ["bachelor"],
      rubric: "r1",
      config: { w: 0.4 },
    };
    const h = hashScoringInput(parts);
    assert.notEqual(
      h,
      hashScoringInput({ ...parts, experienceRows: [{ id: "e1", title: "Site Engineer", domainFinal: true }] }),
    );
    assert.notEqual(
      h,
      hashScoringInput({ ...parts, qualifications: [{ degreeLevel: "bachelor", degreeTitle: "BE Mechanical" }] }),
    );
    assert.notEqual(h, hashScoringInput({ ...parts, rubric: "r2" }));
    assert.equal(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] }), stableStringify({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });

  it("subject hash depends only on transcripts", () => {
    const t = [{ id: "d1", text: "MATH 101", degreeLevel: "bachelor" }];
    assert.equal(hashSubjectInput(t), hashSubjectInput([...t]));
    assert.notEqual(hashSubjectInput(t), hashSubjectInput([{ ...t[0]!, degreeLevel: "master" }]));
  });
});

describe("#9 work boost applied before the top-N cut", () => {
  it("lets a 4th-ranked related occupation into the top 3", () => {
    const rows = [sub("Engineering Mathematics"), sub("Engineering Physics")];
    const all = scoreAllOccupations(rows);
    const shortlist = all.slice(0, 6);
    const fourth = shortlist[3]!;
    const result = applyBoostAndCut(
      shortlist,
      [{ anzscoCode: fourth.rubric.anzscoCode, related: true, matchedJobs: [], analysis: "related" }],
      3,
    );
    assert.equal(result.length, 3);
    assert.ok(
      result.some((r) => r.rubric.anzscoCode === fourth.rubric.anzscoCode),
      "boosted 4th candidate should make the final top 3",
    );
  });
});

describe("#7 containment false-positive guards (real transcript names)", () => {
  it("does not match generic lab / design / project names", () => {
    assert.equal(rule("Materials Lab I", "Strength of Materials Lab"), null);
    assert.equal(rule("Design & Engineering", "Engineering Design"), null);
    assert.equal(rule("Senior Design Project", "Design Project"), null);
    assert.equal(rule("Computer Programming and", "Computer Programming and Numerical Methods"), null);
  });
  it("still matches real coverage", () => {
    assert.ok(rule("Electricity and Magnetism Lab", "Electricity and Magnetism"));
    assert.ok(rule("Instrumentation & Process Control", "Process Control and Instrumentation"));
    assert.ok(rule("Introduction to Engineering Materials", "Engineering Materials"));
    assert.ok(rule("CH214 Chemical Engineering Thermodynamics", "Chemical Engineering Thermodynamics"));
  });
  it("splits compound titles", () => {
    const rubric = loadRubric("civil-engineer");
    const { matches } = matchSubjectsSync(
      [sub("Differential Equations and Linear Algebra")],
      flattenRubricSubjects(rubric),
    );
    assert.ok(matches.some((m) => m.rubricSubject === "Engineering Mathematics"));
  });
});
