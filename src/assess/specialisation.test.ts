import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtractedSubjectRow, QualificationType } from "./schemas.js";
import {
  assessSpecialisations,
  monthIndex,
  specialisationApplies,
  type SpecialisationInput,
} from "./specialisation.js";

const now = new Date(2026, 10, 1);
function rows(q: QualificationType, names: string[]): ExtractedSubjectRow[] {
  return names.map((name) => ({
    name,
    code: null,
    credits: null,
    grade: null,
    yearOrSemester: null,
    qualification: q,
    sourceSnippet: null,
    isRepeat: false,
  }));
}
const CIVIL_CORE = [
  "Engineering Mathematics I",
  "Engineering Mechanics",
  "Structural Analysis I",
  "Structural Analysis II",
  "Design of Reinforced Concrete Structures",
  "Design of Steel Structures",
  "Soil Mechanics",
  "Fluid Mechanics",
  "Surveying I",
  "Construction Materials",
  "Construction Management",
  "Transportation Engineering I",
];
const STRUCT_BASE = [
  "Structural Dynamics",
  "Earthquake Engineering",
  "Finite Element Methods",
  "Bridge Engineering",
  "Prestressed Concrete",
  "Masonry Structures",
];
const base = (over: Partial<SpecialisationInput>): SpecialisationInput => ({
  rows: rows("bachelor", [...CIVIL_CORE, ...STRUCT_BASE]),
  qualifications: [{ degreeLevel: "bachelor", degreeTitle: "Bachelor of Civil Engineering", institution: "Uni" }],
  experienceRows: [],
  cvText: null,
  now,
  ...over,
});
const spec = (r: ReturnType<typeof assessSpecialisations>, code: string) =>
  r.specialisations.find((s) => s.anzscoCode === code)!;

describe("doc 12 specialisation: Civil core first", () => {
  it("covers all 10 core areas with synonyms", () => {
    const r = assessSpecialisations(base({}));
    assert.equal(r.civilCore.met, true);
    assert.equal(r.civilCore.matched.length, 10);
  });

  it("a missing core area stops the pathways: High Risk, not evaluated", () => {
    const r = assessSpecialisations(
      base({ rows: rows("bachelor", CIVIL_CORE.filter((s) => s !== "Surveying I")) }),
    );
    assert.equal(r.civilCore.met, false);
    assert.deepEqual(r.civilCore.missing, ["Surveying"]);
    for (const s of r.specialisations) {
      assert.equal(s.tier, "high_risk");
      assert.equal(s.chosen, null);
    }
    assert.match(r.audit[0]!.detail, /not evaluated/);
  });
});

describe("Pathway A (Master's)", () => {
  const masterStruct = rows("master", [
    "Advanced Structural Analysis",
    "Advanced Concrete Design",
    "Seismic Design of Structures",
    "Structural Stability",
    "Research Methodology",
    "Thesis",
  ]);
  it("specific title + predominantly structural coursework → No Risk for Structural", () => {
    const r = assessSpecialisations(
      base({
        rows: [...rows("bachelor", [...CIVIL_CORE, ...STRUCT_BASE]), ...masterStruct],
        qualifications: [
          { degreeLevel: "bachelor", degreeTitle: "Bachelor of Civil Engineering", institution: "Uni" },
          { degreeLevel: "master", degreeTitle: "Master of Structural Engineering", institution: "Uni" },
        ],
      }),
    );
    const s = spec(r, "233214");
    assert.equal(s.pathwayA.titleFit, "specific");
    assert.equal(s.pathwayA.subjectsCounted, 4); // thesis / research methods not counted
    assert.equal(s.pathwayA.coursePct, 100);
    assert.equal(s.chosen, "A");
    assert.equal(s.tier, "no_risk");
    assert.match(s.routing, /expedited/);
    // Same Master's is unrelated for Transport.
    assert.equal(spec(r, "233215").pathwayA.titleFit, "unrelated");
    assert.equal(spec(r, "233215").tier, "high_risk");
  });

  it("generic 'Master of Civil Engineering' with part coverage → Slight Risk", () => {
    const r = assessSpecialisations(
      base({
        rows: [
          ...rows("bachelor", [...CIVIL_CORE, ...STRUCT_BASE]),
          ...rows("master", ["Advanced Concrete Design", "Water Resources", "Hydrology", "Seismic Design"]),
        ],
        qualifications: [
          { degreeLevel: "bachelor", degreeTitle: "Bachelor of Civil Engineering", institution: "Uni" },
          { degreeLevel: "master", degreeTitle: "Master of Civil Engineering", institution: "Uni" },
        ],
      }),
    );
    const s = spec(r, "233214");
    assert.equal(s.pathwayA.titleFit, "generic");
    assert.equal(s.pathwayA.tier, "slight_risk");
    assert.equal(s.tier, "slight_risk");
  });
});

describe("Pathway B (work experience)", () => {
  const cv = `Structural Design Engineer
Structural analysis and modelling in ETABS and STAAD.Pro; design of beams, columns and slabs;
wind load and seismic load calculations; structural drawings and detailing to AS 3600; design sign-off.
Site Engineer
Supervised site works.`;
  it("FTE years from merged dates; ≥ 5 years + detailed duties → Slight (references not on file)", () => {
    const r = assessSpecialisations(
      base({
        rows: rows("bachelor", CIVIL_CORE), // base subjects partial → academic slight at best
        experienceRows: [
          { title: "Structural Design Engineer", start: "Jan 2019", end: "Present", domainFinal: true },
          { title: "Site Engineer", start: "2017", end: "Dec 2018", domainFinal: true },
        ],
        cvText: cv,
      }),
    );
    const s = spec(r, "233214");
    assert.equal(s.pathwayB.fteYears, 7.9); // Jan 2019 – Nov 2026 (95 months)
    assert.equal(s.pathwayB.roles[0]!.counted, true);
    assert.equal(s.pathwayB.roles[1]!.counted, false);
    assert.equal(s.pathwayB.competencyPct, 100);
    assert.equal(s.pathwayB.tier, "slight_risk");
    assert.equal(s.chosen, "B");
    assert.ok(s.gaps.some((g) => /Reference letters/.test(g)));
  });

  it("no Master's: Pathway B alone is evaluated; under 5 years → High Risk", () => {
    const r = assessSpecialisations(
      base({
        experienceRows: [{ title: "Structural Engineer", start: "Jan 2023", end: "Present", domainFinal: true }],
        cvText: cv,
      }),
    );
    const s = spec(r, "233214");
    assert.equal(s.pathwayA.available, false);
    assert.equal(s.chosen, "B");
    assert.equal(s.pathwayB.satisfied, false);
    assert.equal(s.tier, "high_risk");
  });

  it("part-time roles count at 0.5 FTE and overlaps are not double counted", () => {
    const r = assessSpecialisations(
      base({
        experienceRows: [
          { title: "Structural Engineer", start: "Jan 2020", end: "Dec 2021", domainFinal: true },
          { title: "Structural Engineer (part-time)", start: "Jan 2022", end: "Dec 2023", domainFinal: true },
          { title: "Bridge Engineer", start: "Jan 2021", end: "Dec 2021", domainFinal: true },
        ],
        cvText: null,
      }),
    );
    assert.equal(spec(r, "233214").pathwayB.fteYears, 3);
  });
});

describe("helpers", () => {
  it("parses common CV date forms", () => {
    assert.equal(monthIndex("Jan 2020", now), 2020 * 12);
    assert.equal(monthIndex("September 2021", now), 2021 * 12 + 8);
    assert.equal(monthIndex("03/2019", now), 2019 * 12 + 2);
    assert.equal(monthIndex("2018", now, true), 2018 * 12 + 11);
    assert.equal(monthIndex("Present", now), 2026 * 12 + 10);
    assert.equal(monthIndex("", now), null);
  });
  it("applies to civil-family candidates or a civil bachelor only", () => {
    assert.equal(specialisationApplies({ candidateCodes: ["233211"], qualifications: [] }), true);
    assert.equal(
      specialisationApplies({ candidateCodes: ["233411"], qualifications: [{ degreeLevel: "bachelor", degreeTitle: "BE Electronics" }] }),
      false,
    );
    assert.equal(
      specialisationApplies({ candidateCodes: [], qualifications: [{ degreeLevel: "bachelor", degreeTitle: "B.E. Civil" }] }),
      true,
    );
  });
  it("records an audit entry for the core and each specialisation", () => {
    const r = assessSpecialisations(base({}));
    assert.equal(r.audit.length, 4);
    assert.equal(r.specialisations.length, 3);
  });
});
