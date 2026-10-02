import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { heuristicsExperienceFromText } from "./heuristics.js";
import { experienceExtractSchema } from "./schemas.js";

/** Fixture: Faizan-style CV line with duration only (no start/end dates). */
const UCC_DURATION_ONLY_CV = `MUHAMMAD FAIZAN
CAREER OBJECTIVE:
In request of suitable portfolio, career-oriented job.
Personal Information:
Academic Information:
Degree
B. Sc Civil Engineering Technology
GCUF (Layyah Campus)
Experience:
3 Years experience as a Site Supervisor in UCC Pvt. Ltd
Language
English
Urdu
`;

describe("experience duration-only extraction", () => {
  it("extracts UCC Site Supervisor with null dates", () => {
    const result = heuristicsExperienceFromText(UCC_DURATION_ONLY_CV);
    const parsed = experienceExtractSchema.parse(result);
    assert.ok(parsed.rows.length >= 1, "expected at least one experience row");

    const row = parsed.rows.find(
      (r) =>
        /UCC/i.test(r.employer ?? "") && /Site Supervisor/i.test(r.title ?? ""),
    );
    assert.ok(row, "expected UCC Site Supervisor row");
    assert.equal(row!.employer, "UCC Pvt. Ltd");
    assert.equal(row!.title, "Site Supervisor");
    assert.equal(row!.start, null);
    assert.equal(row!.end, null);
  });

  it("schema accepts rows with null start/end", () => {
    const parsed = experienceExtractSchema.parse({
      rows: [
        {
          employer: "UCC Pvt. Ltd",
          title: "Site Supervisor",
          start: null,
          end: null,
          domainMatch: null,
        },
      ],
    });
    assert.equal(parsed.rows[0]!.employer, "UCC Pvt. Ltd");
    assert.equal(parsed.rows[0]!.start, null);
  });
});
