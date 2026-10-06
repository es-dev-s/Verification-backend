import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countryFieldsMatch,
  parseOutcomePossibility,
  textFieldsMatch,
  universityFieldsMatch,
} from "./precedent.js";

describe("parseOutcomePossibility", () => {
  it("maps datasheet risk tiers", () => {
    assert.equal(parseOutcomePossibility("No Risk"), "no_risk");
    assert.equal(parseOutcomePossibility("Slight Risk"), "slight_risk");
    assert.equal(parseOutcomePossibility("High Risk"), "high_risk");
    assert.equal(parseOutcomePossibility(null), null);
    assert.equal(parseOutcomePossibility("unknown"), null);
  });
});

describe("field matchers", () => {
  it("matches degree titles loosely", () => {
    assert.equal(
      textFieldsMatch(
        "Bachelor of Science in Chemical Engineering",
        "BSc Chemical Engineering",
      ),
      true,
    );
    assert.equal(
      textFieldsMatch("Civil Engineering", "Mechanical Engineering"),
      false,
    );
  });

  it("matches universities including acronyms", () => {
    assert.equal(
      universityFieldsMatch(
        "Jawaharlal Nehru Technological University Hyderabad",
        "JNTUH",
      ),
      true,
    );
  });

  it("matches countries case-insensitively", () => {
    assert.equal(countryFieldsMatch("India", "india"), true);
    assert.equal(countryFieldsMatch("Pakistan", "India"), false);
  });
});
