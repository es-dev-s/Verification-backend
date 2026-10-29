import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { applyDocumentLevels, assessExtractedSubjects } from "./assessCase.js";
import { degreeLevelFromTitle, degreeLevelToQualification } from "./extractSubjects.js";
import { flattenRubricSubjects, loadRubric } from "./loadRubric.js";
import { matchOptionsForRubric, matchSubjectsSync } from "./matchSubjects.js";
import { checkQualification } from "./qualificationCheck.js";
import type { ExtractedSubjectRow, QualificationType } from "./schemas.js";

const here = dirname(fileURLToPath(import.meta.url));
const subjectsFile = JSON.parse(
  readFileSync(resolve(here, "../lib/anzsco_subjects.json"), "utf8"),
);

function row(name: string, qualification: QualificationType = "diploma"): ExtractedSubjectRow {
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

/** Strong 312511 transcript: Tier 1 4/4, Tier 2 9/9, drafting project. */
const STRONG_DRAFTING = [
  "Applied Mathematics I",
  "Applied Physics",
  "Applied Chemistry",
  "Engineering Drawing I",
  "AutoCAD",
  "SolidWorks",
  "GD&T",
  "Machine Design I",
  "Manufacturing Technology I",
  "Engineering Materials",
  "Strength of Materials",
  "Hydraulics and Pneumatics",
  "Tool Design",
  "Drafting Project",
];

function gateNames(occupationId: string, names: string[]): string[] {
  const rubric = loadRubric(occupationId);
  const gate = rubric.tiers.tier3.gate!.gateSubject;
  const { matches } = matchSubjectsSync(
    names.map((n) => row(n)),
    flattenRubricSubjects(rubric),
    matchOptionsForRubric(rubric),
  );
  return [
    ...new Set(
      matches.filter((m) => m.rubricSubject === gate).map((m) => m.transcriptName),
    ),
  ];
}

function matchedSubjects(occupationId: string, name: string): string[] {
  const rubric = loadRubric(occupationId);
  const { matches } = matchSubjectsSync(
    [row(name)],
    flattenRubricSubjects(rubric),
    matchOptionsForRubric(rubric),
  );
  return matches.filter((m) => m.rubricSubject).map((m) => m.rubricSubject!);
}

describe("degree levels (diploma / advanced diploma / associate degree)", () => {
  it("maps DB levels and titles", () => {
    assert.equal(degreeLevelToQualification("bachelor"), "bachelor");
    assert.equal(degreeLevelToQualification("master"), "master");
    assert.equal(degreeLevelToQualification("diploma"), "diploma");
    assert.equal(degreeLevelToQualification("advanced_diploma"), "advanced_diploma");
    assert.equal(
      degreeLevelToQualification("advanced_diploma", "Associate Degree in Mechanical Engineering Drafting"),
      "associate_degree",
    );
    assert.equal(degreeLevelToQualification("phd"), "unknown");
    assert.equal(degreeLevelToQualification(null, "Advanced Diploma of Engineering"), "advanced_diploma");
    assert.equal(degreeLevelToQualification(null, null), "unknown");
  });

  it("reads the level from a title", () => {
    assert.equal(degreeLevelFromTitle("Diploma of Engineering - Mechanical Drafting"), "diploma");
    assert.equal(degreeLevelFromTitle("Adv. Diploma of Engineering"), "advanced_diploma");
    assert.equal(degreeLevelFromTitle("Associate of Applied Science"), "associate_degree");
    assert.equal(degreeLevelFromTitle("Bachelor of Engineering Technology (Mechanical)"), "bachelor");
    assert.equal(degreeLevelFromTitle("Master of Engineering"), "master");
    assert.equal(degreeLevelFromTitle("Graduate Diploma of Engineering"), null);
    assert.equal(degreeLevelFromTitle("Mechanical Drafting"), null);
  });

  it("tags saved unknown rows from their transcript, never changing bachelor / master", () => {
    const rows = [
      { ...row("A", "unknown"), documentId: "d1" },
      { ...row("B", "bachelor"), documentId: "d1" },
      { ...row("C", "diploma"), documentId: "d2" },
      { ...row("D", "master"), documentId: "d2" },
    ];
    const out = applyDocumentLevels(rows, [
      { id: "d1", level: "diploma" },
      { id: "d2", level: "associate_degree" },
    ]);
    assert.deepEqual(
      out.map((r) => r.qualification),
      ["diploma", "bachelor", "associate_degree", "master"],
    );
  });

  it("scores diploma-level rows as their own group", () => {
    const rows = [
      ...STRONG_DRAFTING.map((n) => row(n, "diploma")),
      row("Engineering Mathematics", "bachelor"),
    ];
    const r = assessExtractedSubjects(rows, {
      occupationId: "mechanical-engineering-draftsperson",
      qualifications: [
        { level: "diploma", title: "Diploma of Engineering - Mechanical Drafting/Design" },
      ],
    });
    assert.equal(r.transcriptSource?.kind, "diploma");
    assert.equal(r.mastersFallbackUsed, false);
    assert.deepEqual(r.qualificationsUsed, ["diploma"]);
  });
});

describe("312511 Step 1 qualification check", () => {
  const id = "mechanical-engineering-draftsperson";

  it("verifies a mechanical drafting diploma", () => {
    const r = assessExtractedSubjects(STRONG_DRAFTING.map((n) => row(n)), {
      occupationId: id,
      qualifications: [
        { level: "diploma", title: "Diploma of Engineering - Mechanical Drafting/Design" },
      ],
    });
    assert.equal(r.coreMatched, 9);
    assert.equal(r.foundationalMatched, 4);
    assert.equal(r.tier3GateMet, true);
    assert.equal(r.determination, "verified_no_risk");
    assert.deepEqual(r.qualificationNotes, []);
    assert.equal(r.candidates?.[0]?.qualificationCapped, false);
  });

  it("accepts an associate degree in mechanical engineering drafting", () => {
    const r = assessExtractedSubjects(STRONG_DRAFTING.map((n) => row(n, "associate_degree")), {
      occupationId: id,
      qualifications: [
        { level: "associate_degree", title: "Associate Degree in Mechanical Engineering Drafting" },
      ],
    });
    assert.equal(r.determination, "verified_no_risk");
  });

  it("caps a different field at conditional with a note", () => {
    const r = assessExtractedSubjects(STRONG_DRAFTING.map((n) => row(n)), {
      occupationId: id,
      qualifications: [{ level: "diploma", title: "Diploma of Civil Engineering" }],
    });
    assert.equal(r.determination, "conditional");
    assert.equal(r.candidates?.[0]?.qualificationCapped, true);
    assert.match(r.qualificationNotes?.[0] ?? "", /does not read as Mechanical Engineering Drafting/);
    assert.match(r.explanation, /Qualification check:/);
  });

  it("caps when no qualification title is on file", () => {
    const r = assessExtractedSubjects(STRONG_DRAFTING.map((n) => row(n)), { occupationId: id });
    assert.equal(r.determination, "conditional");
    assert.match(r.qualificationNotes?.[0] ?? "", /title not on file/);
  });
});

describe("professional engineers: no diploma cap in the scorer (Gate 1 decides)", () => {
  const eng = loadRubric("mechanical-engineer");

  it("the qualification check no longer caps a diploma-only pool", () => {
    assert.deepEqual(checkQualification(eng, ["diploma"]), { capAtConditional: false, notes: [] });
    assert.equal(checkQualification(eng, ["unknown"], [{ level: "advanced_diploma", title: null }]).capAtConditional, false);
  });

  it("leaves bachelor pools alone", () => {
    assert.deepEqual(checkQualification(eng, ["bachelor"]), { capAtConditional: false, notes: [] });
    assert.deepEqual(checkQualification(eng, ["bachelor", "unknown"]), { capAtConditional: false, notes: [] });
  });
});

describe("312511 drafting gate", () => {
  it("a generic project title does not meet the 312511 gate", () => {
    assert.deepEqual(
      gateNames("mechanical-engineering-draftsperson", [
        "Final Year Project",
        "Major Project",
        "Capstone Project",
        "Project Work",
      ]),
      [],
    );
  });

  it("drafting / design / CAD projects meet it", () => {
    const names = [
      "Final Year Design Project",
      "CAD Project",
      "Drafting Project",
      "Capstone Design Project",
      "Major Project - Machine Drawing",
      "Final Year Project (3D Modelling)",
    ];
    assert.deepEqual(gateNames("mechanical-engineering-draftsperson", names), names);
  });

  it("engineers keep the plain project rule", () => {
    assert.deepEqual(gateNames("mechanical-engineer", ["Final Year Project", "Major Project"]), [
      "Final Year Project",
      "Major Project",
    ]);
  });

  it("a missing drafting gate turns verified into conditional", () => {
    const names = STRONG_DRAFTING.filter((n) => n !== "Drafting Project").concat("Final Year Project");
    const r = assessExtractedSubjects(names.map((n) => row(n)), {
      occupationId: "mechanical-engineering-draftsperson",
      qualifications: [{ level: "diploma", title: "Diploma of Mechanical Drafting" }],
    });
    assert.equal(r.tier3GateMet, false);
    assert.equal(r.determination, "conditional");
  });
});

describe("312511 Principle 2 combined CAD course", () => {
  it("one course satisfies 2D CAD and 3D modelling", () => {
    const hits = matchedSubjects(
      "mechanical-engineering-draftsperson",
      "Computer Aided Design and Solid Modelling",
    );
    assert.ok(hits.includes("Computer-Aided Design (2D CAD)"), hits.join(", "));
    assert.ok(hits.includes("3D Parametric Modeling / Solid Modeling"), hits.join(", "));
  });

  it("is off for other occupations", () => {
    const rubric = loadRubric("mechanical-engineer");
    assert.equal(matchOptionsForRubric(rubric).combinedCourses, undefined);
  });
});

describe("312511 subjects data", () => {
  const entry = subjectsFile.find(
    (o: any) => o.occupationId === "mechanical-engineering-draftsperson",
  );
  const ids = (group: string) => entry.groups[group].subjects.map((s: any) => s.id);
  const variants = (group: string, id: string) =>
    entry.groups[group].subjects.find((s: any) => s.id === id).variants as string[];

  it("Workshop Practice sits in Tier 3 optional", () => {
    assert.ok(!ids("tier1").includes("312511-T3.O1"));
    assert.equal(ids("tier3_optional")[0], "312511-T3.O1");
    const s = loadRubric("mechanical-engineering-draftsperson").tiers.tier3.subjects.find(
      (x) => x.name === "Workshop Practice / Basic Fabrication",
    );
    assert.equal(s?.category, "optional");
  });

  it("Principle 1 CAD variants satisfy 2D CAD", () => {
    const v = variants("tier2_core", "312511-T2.1");
    for (const name of ["AutoCAD", "SolidWorks", "Creo", "Pro-E", "Creo / Pro-E", "Inventor", "Advanced CAD", "CAMD", "Computer Aided Machine Drawing"]) {
      assert.ok(v.includes(name), name);
    }
    for (const name of ["SolidWorks", "Creo", "CAMD", "3D Modelling"]) {
      assert.ok(
        matchedSubjects("mechanical-engineering-draftsperson", name).includes("Computer-Aided Design (2D CAD)"),
        name,
      );
    }
  });

  it("Modelling / Modeling both spellings and plain Metrology match", () => {
    for (const name of ["Solid Modelling", "Solid Modeling", "3D Modelling", "3D Modeling"]) {
      assert.ok(
        matchedSubjects("mechanical-engineering-draftsperson", name).includes(
          "3D Parametric Modeling / Solid Modeling",
        ),
        name,
      );
    }
    assert.ok(
      matchedSubjects("mechanical-engineering-draftsperson", "Metrology").includes(
        "Geometric Dimensioning & Tolerancing (GD&T)",
      ),
    );
  });
});
