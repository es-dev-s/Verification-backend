import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guessEngineeringRelated } from "./heuristics.js";
import { heuristicsExperienceFromText } from "./heuristics.js";

describe("guessEngineeringRelated", () => {
  it("flags clear engineering titles as true", () => {
    assert.equal(guessEngineeringRelated("Site Supervisor", "UCC Pvt. Ltd"), true);
    assert.equal(guessEngineeringRelated("Civil Engineer", null), true);
  });

  it("flags clear non-engineering titles as false", () => {
    assert.equal(guessEngineeringRelated("Accountant", "ACME Corp"), false);
  });

  it("returns null when duties/title are too thin to decide", () => {
    assert.equal(guessEngineeringRelated("Associate", "ACME"), null);
    assert.equal(guessEngineeringRelated(null, null), null);
  });
});

describe("experience heuristics domainMatch", () => {
  it("sets domainMatch true for Site Supervisor duration-only row", () => {
    const text = `
Experience:
3 Years experience as a Site Supervisor in UCC Pvt. Ltd
`;
    const { rows } = heuristicsExperienceFromText(text);
    const row = rows.find((r) => /Site Supervisor/i.test(r.title ?? ""));
    assert.ok(row);
    assert.equal(row!.domainMatch, true);
  });
});
