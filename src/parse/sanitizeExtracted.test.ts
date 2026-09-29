import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  sanitizeDegreeTitle,
  sanitizeEducationExtract,
  sanitizeExtractedLabel,
} from "./sanitizeExtracted.js";

describe("sanitizeDegreeTitle", () => {
  it("strips truncated parenthetical (Pow", () => {
    assert.equal(
      sanitizeDegreeTitle("Bachelor of Science in Electrical (Pow"),
      "Bachelor of Science in Electrical",
    );
  });

  it("keeps balanced parentheses", () => {
    assert.equal(
      sanitizeDegreeTitle("Bachelor of Engineering (Hons.), Civil Engineering"),
      "Bachelor of Engineering (Hons.), Civil Engineering",
    );
  });

  it("removes curly braces", () => {
    assert.equal(
      sanitizeDegreeTitle("{Bachelor of Science in Electrical (Pow}"),
      "Bachelor of Science in Electrical",
    );
  });

  it("returns null for empty junk", () => {
    assert.equal(sanitizeDegreeTitle("  {}  "), null);
  });
});

describe("sanitizeEducationExtract", () => {
  it("cleans degree and institution", () => {
    const out = sanitizeEducationExtract({
      degreeTitle: "Bachelor of Science in Electrical (Pow",
      institution: "{COMSATS University}",
      country: "Pakistan",
    });
    assert.equal(out.degreeTitle, "Bachelor of Science in Electrical");
    assert.equal(out.institution, "COMSATS University");
    assert.equal(out.country, "Pakistan");
  });
});

describe("sanitizeExtractedLabel", () => {
  it("strips braces from labels", () => {
    assert.equal(sanitizeExtractedLabel("{Moi University}"), "Moi University");
  });
});
