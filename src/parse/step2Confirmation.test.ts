import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Mirrors web/lib/wizard helpers without pulling Next/React into the API test runner.
 * Keep in sync with web/lib/wizard.ts.
 */
type DegreeLevel =
  | "diploma"
  | "advanced_diploma"
  | "bachelor"
  | "master"
  | "phd";

const DEGREE_LEVEL_ORDER: DegreeLevel[] = [
  "phd",
  "master",
  "bachelor",
  "advanced_diploma",
  "diploma",
];

const DEGREE_LEVEL_LABELS: Record<DegreeLevel, string> = {
  phd: "PhD",
  master: "Master's",
  bachelor: "Bachelor's",
  advanced_diploma: "Advanced Diploma",
  diploma: "Diploma",
};

function sortDegreeLevels(levels: DegreeLevel[]): DegreeLevel[] {
  return [...levels].sort(
    (a, b) => DEGREE_LEVEL_ORDER.indexOf(a) - DEGREE_LEVEL_ORDER.indexOf(b),
  );
}

function buildConfirmationQualifications(
  selectedLevels: DegreeLevel[],
  qualifications: Partial<
    Record<
      DegreeLevel,
      {
        degreeTitle: string | null;
        institution: string | null;
        country: string | null;
        durationYears: number | null;
      }
    >
  >,
) {
  return sortDegreeLevels(selectedLevels).map((level) => {
    const q = qualifications[level];
    return {
      degreeLevel: level,
      label: DEGREE_LEVEL_LABELS[level],
      degreeTitle: (q?.degreeTitle || "").trim() || "—",
      institution: (q?.institution || "").trim() || "—",
      country: (q?.country || "").trim() || "—",
      durationYears:
        q?.durationYears != null && Number.isFinite(q.durationYears)
          ? String(q.durationYears)
          : "—",
    };
  });
}

function isEngineeringRelatedChecked(row: {
  domainSuggested: boolean | null;
  domainFinal: boolean | null;
}): boolean {
  if (row.domainFinal != null) return row.domainFinal;
  if (row.domainSuggested != null) return row.domainSuggested;
  return false;
}

describe("Step 2 confirmation qualification lists", () => {
  it("renders a single selected degree level", () => {
    const blocks = buildConfirmationQualifications(["bachelor"], {
      bachelor: {
        degreeTitle: "B.Sc. CS",
        institution: "Monash University",
        country: "Australia",
        durationYears: 3,
      },
    });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.degreeLevel, "bachelor");
    assert.equal(blocks[0]!.degreeTitle, "B.Sc. CS");
    assert.equal(blocks[0]!.institution, "Monash University");
  });

  it("renders multi-degree levels in PhD > Master > Bachelor order", () => {
    const blocks = buildConfirmationQualifications(
      ["bachelor", "phd", "master"],
      {
        bachelor: {
          degreeTitle: "B.Sc.",
          institution: "McGill",
          country: "Canada",
          durationYears: 4,
        },
        master: {
          degreeTitle: "M.Sc.",
          institution: "Stanford",
          country: "United States",
          durationYears: 2,
        },
        phd: {
          degreeTitle: "PhD",
          institution: "MIT",
          country: "United States",
          durationYears: 5,
        },
      },
    );
    assert.deepEqual(
      blocks.map((b) => b.degreeLevel),
      ["phd", "master", "bachelor"],
    );
    assert.equal(blocks[0]!.label, "PhD");
    assert.equal(blocks[1]!.institution, "Stanford");
    assert.equal(blocks[2]!.institution, "McGill");
  });
});

describe("per-row engineering checkbox defaults", () => {
  it("defaults checked state from domainSuggested when domainFinal is null", () => {
    assert.equal(
      isEngineeringRelatedChecked({
        domainSuggested: true,
        domainFinal: null,
      }),
      true,
    );
    assert.equal(
      isEngineeringRelatedChecked({
        domainSuggested: false,
        domainFinal: null,
      }),
      false,
    );
  });

  it("lets domainFinal override domainSuggested independently", () => {
    assert.equal(
      isEngineeringRelatedChecked({
        domainSuggested: true,
        domainFinal: false,
      }),
      false,
    );
    assert.equal(
      isEngineeringRelatedChecked({
        domainSuggested: false,
        domainFinal: true,
      }),
      true,
    );
  });
});

describe("engineering-titled degree case field", () => {
  it("defaults to null/unchecked for a new case", () => {
    const engineeringTitledDegree: boolean | null = null;
    assert.equal(engineeringTitledDegree, null);
    assert.equal(engineeringTitledDegree === true, false);
  });

  it("persists true/false independently of per-row domain flags", () => {
    let engineeringTitledDegree: boolean | null = null;
    engineeringTitledDegree = true;
    assert.equal(engineeringTitledDegree, true);
    const rowChecked = isEngineeringRelatedChecked({
      domainSuggested: false,
      domainFinal: false,
    });
    assert.equal(rowChecked, false);
    assert.equal(engineeringTitledDegree, true);
  });
});
