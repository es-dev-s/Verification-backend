import assert from "node:assert/strict";
import { test } from "node:test";
import {
  highestDegree,
  nameFromFileName,
  parseOccupationLabel,
  resolveOccupation,
  snippet,
  verificationOf,
} from "./clientSummary.js";

test("verificationOf: approved, rejected, otherwise unverified", () => {
  assert.equal(verificationOf("APPROVED"), "approved");
  assert.equal(verificationOf("REJECTED"), "rejected");
  assert.equal(verificationOf(null), "unverified");
  assert.equal(verificationOf(undefined), "unverified");
});

test("nameFromFileName strips numbering, cv/resume words and extensions", () => {
  assert.equal(nameFromFileName("7. Rahna - cv.docx"), "Rahna");
  assert.equal(nameFromFileName("Shobit Razdan RESUME 25052026.docx"), "Shobit Razdan");
  assert.equal(nameFromFileName("3. Shah Khalid Resume.png"), "Shah Khalid");
  assert.equal(nameFromFileName("Cem_Ergen_Resume.pdf"), "Cem Ergen");
  assert.equal(nameFromFileName("Jane Doe Résumé (1).pdf"), "Jane Doe");
  assert.equal(nameFromFileName("cv.pdf"), null);
  assert.equal(nameFromFileName(""), null);
});

test("parseOccupationLabel splits title and code", () => {
  assert.deepEqual(parseOccupationLabel("Chemical Engineer (233111)"), {
    title: "Chemical Engineer",
    anzscoCode: "233111",
  });
  assert.deepEqual(parseOccupationLabel("Civil Engineer"), {
    title: "Civil Engineer",
    anzscoCode: null,
  });
  assert.equal(parseOccupationLabel(null), null);
});

test("resolveOccupation prefers the stored risk selection", () => {
  assert.deepEqual(
    resolveOccupation({
      riskCode: "233211",
      riskTitle: "Civil Engineer",
      targetOccupation: "Chemical Engineer (233111)",
      assessmentCode: "233111",
    }),
    { anzscoCode: "233211", title: "Civil Engineer" },
  );
  assert.deepEqual(
    resolveOccupation({ assessmentCode: "233111", assessmentTitle: "Chemical Engineer" }),
    { anzscoCode: "233111", title: "Chemical Engineer" },
  );
});

test("highestDegree picks the highest titled qualification", () => {
  const d = highestDegree(
    [
      { degreeLevel: "bachelor", degreeTitle: "BE Civil", institution: "TU" },
      { degreeLevel: "master", degreeTitle: "MSc Structures", institution: "KU" },
      { degreeLevel: "phd", degreeTitle: null, institution: null },
    ],
    ["bachelor", "master", "phd"],
  );
  assert.equal(d.degreeLevel, "master");
  assert.equal(d.degreeTitle, "MSc Structures");
  const fallback = highestDegree([], ["diploma", "bachelor"]);
  assert.equal(fallback.degreeLabel, "Bachelor's");
  assert.equal(fallback.degreeTitle, null);
});

test("snippet trims long comments", () => {
  assert.equal(snippet("  short  "), "short");
  assert.equal(snippet("a".repeat(200), 10)?.length, 10);
  assert.equal(snippet(null), null);
});
