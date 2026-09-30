import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { heuristicsCvEducationEntries } from "./heuristics.js";
import { cvEducationExtractSchema } from "./schemas.js";

const MULTI_LEVEL_CV = `
EDUCATION
M.Sc. Petroleum Engineering | Suez University | 04/2025
Egypt
B.Sc. Petroleum Engineering | Middle East Technical University (METU) | 02/2021
Ankara, Turkey
Advanced Diploma of Information Technology | Bella College Australia | 2020
`;

describe("CV multi-entry education schema", () => {
  it("accepts an array of leveled entries", () => {
    const parsed = cvEducationExtractSchema.parse({
      entries: [
        {
          degreeLevel: "master",
          degreeTitle: "M.Sc. Petroleum Engineering",
          institution: "Suez University",
          country: "Egypt",
          start: null,
          end: "2025",
          statedDuration: null,
          multipleBachelors: false,
        },
        {
          degreeLevel: "bachelor",
          degreeTitle: "B.Sc. Petroleum Engineering",
          institution: "METU",
          country: "Turkey",
          start: null,
          end: "2021",
          statedDuration: null,
          multipleBachelors: false,
        },
      ],
    });
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.entries[0]!.degreeLevel, "master");
    assert.equal(parsed.entries[1]!.degreeLevel, "bachelor");
  });
});

describe("heuristicsCvEducationEntries", () => {
  it("returns multiple leveled entries from a CV education block", () => {
    const { entries } = heuristicsCvEducationEntries(MULTI_LEVEL_CV);
    const levels = new Set(entries.map((e) => e.degreeLevel));
    assert.ok(levels.has("master"), `expected master, got ${[...levels]}`);
    assert.ok(levels.has("bachelor"), `expected bachelor, got ${[...levels]}`);
    assert.ok(
      levels.has("advanced_diploma"),
      `expected advanced_diploma, got ${[...levels]}`,
    );
  });
});
