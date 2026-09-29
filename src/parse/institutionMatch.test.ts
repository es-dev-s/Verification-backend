import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeDuration, extractYearRange } from "./duration.js";
import {
  institutionAcronym,
  isLikelyAcronymMatch,
  normalizeInstitutionCore,
} from "./institutionMatch.js";
import { mergeEducation } from "./mergeEducation.js";
import { correctOcrEducationText } from "./ocrCorrect.js";

describe("extractYearRange / duration", () => {
  it("parses SESSION 2019-2023", () => {
    assert.deepEqual(extractYearRange("SESSION 2019-2023"), {
      startYear: 2019,
      endYear: 2023,
    });
  });

  it("computes 4 years from year-only start/end", () => {
    const d = computeDuration({ start: "2019", end: "2023" });
    assert.equal(d.years, 4);
    assert.equal(d.calculated, true);
  });

  it("ignores Result Declaration style stamps as end-only", () => {
    const d = computeDuration({ start: null, end: "16-AUG-23" });
    assert.equal(d.years, null);
  });

  it("prefers stated years over session when both present", () => {
    const d = computeDuration({
      statedDuration: "4 years",
      start: "2019",
      end: "2023",
    });
    assert.equal(d.years, 4);
    assert.equal(d.calculated, false);
  });
});

describe("OCR institution corrections", () => {
  it("fixes Aniversity → University", () => {
    const { text, corrections } = correctOcrEducationText(
      "Government College Aniversity Faisalabad",
      "doc-test",
    );
    assert.match(text, /University/);
    assert.equal(corrections.length >= 1, true);
    assert.equal(corrections[0]!.corrected.toLowerCase(), "university");
  });
});

describe("isLikelyAcronymMatch", () => {
  it("matches GCUF (Layyah Campus) to Government College University Faisalabad", () => {
    assert.equal(
      isLikelyAcronymMatch(
        "Government College University Faisalabad",
        "GCUF (Layyah Campus)",
      ),
      true,
    );
  });

  it("builds GCUF acronym", () => {
    assert.equal(
      institutionAcronym("Government College University Faisalabad"),
      "GCUF",
    );
  });

  it("strips parenthetical campus", () => {
    assert.equal(
      normalizeInstitutionCore("GCUF (Layyah Campus)"),
      "gcuf",
    );
  });

  it("does not match unrelated universities", () => {
    assert.equal(
      isLikelyAcronymMatch(
        "University of Melbourne",
        "Government College University Faisalabad",
      ),
      false,
    );
  });
});

describe("mergeEducation institution acronym", () => {
  it("does not flag GCUF vs full name as conflict", () => {
    const merged = mergeEducation([
      {
        documentId: "t1",
        documentType: "TRANSCRIPT",
        extract: {
          degreeTitle: "B.Sc Civil Engineering Technology",
          institution: "Government College University Faisalabad",
          country: "Pakistan",
          start: "2019",
          end: "2023",
          statedDuration: null,
          multipleBachelors: false,
        },
      },
      {
        documentId: "c1",
        documentType: "CV",
        extract: {
          degreeTitle: "BSc Civil Engineering Technology",
          institution: "GCUF (Layyah Campus)",
          country: null,
          start: "2019",
          end: "2023",
          statedDuration: null,
          multipleBachelors: false,
        },
      },
    ]);

    assert.equal(
      merged.fields.institution.value,
      "Government College University Faisalabad",
    );
    assert.equal(merged.fields.institution.conflict, false);
    assert.equal(
      merged.fields.institution.alternatives.some(
        (a) =>
          a.value.includes("GCUF") &&
          a.label === "same institution, abbreviated",
      ),
      true,
    );
    assert.equal(merged.fields.durationYears.value, "4");
    assert.equal(merged.durationCalculated, true);
  });
});
