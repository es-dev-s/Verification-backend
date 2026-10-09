import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseProjectSource } from "./projectSource.js";

describe("parseProjectSource", () => {
  it("accepts enum values and UI labels", () => {
    assert.equal(parseProjectSource("WORK_BASED"), "WORK_BASED");
    assert.equal(parseProjectSource("Work-based project"), "WORK_BASED");
    assert.equal(parseProjectSource("Academic/personal project"), "ACADEMIC_PERSONAL");
    assert.equal(parseProjectSource("firm prepared"), "FIRM_PREPARED");
  });

  it("empty means not chosen, unknown is invalid", () => {
    assert.equal(parseProjectSource(""), null);
    assert.equal(parseProjectSource("  "), null);
    assert.equal(parseProjectSource("thesis"), undefined);
  });
});
