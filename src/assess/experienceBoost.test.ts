import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeWorkExperienceForCandidates } from "./experienceBoost.js";

describe("analyzeWorkExperienceForCandidates", () => {
  it("returns related=false for all occupations when LLM is disabled", async () => {
    const result = await analyzeWorkExperienceForCandidates(
      [
        {
          title: "Process Engineer",
          employer: "ChemCo",
          domainFinal: true,
        },
      ],
      [
        { anzscoCode: "233111", title: "Chemical Engineer" },
        { anzscoCode: "233211", title: "Civil Engineer" },
      ],
      { useLlm: false },
    );

    assert.equal(result.length, 2);
    assert.equal(result[0]?.related, false);
    assert.equal(result[1]?.related, false);
    assert.deepEqual(result[0]?.matchedJobs, []);
    assert.equal(result[0]?.analysis, "");
  });

  it("returns empty judgements when there are no job titles", async () => {
    const result = await analyzeWorkExperienceForCandidates(
      [{ title: null, employer: null, domainFinal: true }],
      [{ anzscoCode: "233111", title: "Chemical Engineer" }],
      { useLlm: true },
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]?.related, false);
  });
});
