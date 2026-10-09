import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EPISODE_EVIDENCE_FIELDS,
  parseEvidenceFlag,
  parseEvidenceFlags,
} from "./episodeEvidence.js";

test("parseEvidenceFlag accepts common true/false spellings", () => {
  for (const v of ["true", "TRUE", "1", "on", "yes", " true "]) {
    assert.equal(parseEvidenceFlag(v), true, v);
  }
  for (const v of ["false", "0", "off", "no", "", "  "]) {
    assert.equal(parseEvidenceFlag(v), false, v);
  }
  assert.equal(parseEvidenceFlag("maybe"), undefined);
  assert.equal(parseEvidenceFlag("2"), undefined);
});

test("parseEvidenceFlags defaults missing fields to false", () => {
  const res = parseEvidenceFlags((f) => (f === "hasDataTables" ? "true" : ""));
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(Object.keys(res.evidence).length, EPISODE_EVIDENCE_FIELDS.length);
  assert.equal(res.evidence.hasDataTables, true);
  assert.equal(res.evidence.hasCalculations, false);
  assert.equal(res.evidence.hasQuantifiableOutcomes, false);
});

test("parseEvidenceFlags reports the invalid field", () => {
  const res = parseEvidenceFlags((f) => (f === "hasDrawingsCad" ? "yesplease" : "1"));
  assert.deepEqual(res, { ok: false, field: "hasDrawingsCad" });
});
