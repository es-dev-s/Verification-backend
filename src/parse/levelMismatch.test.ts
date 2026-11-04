import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MULTI_AWARD_TEXT,
  POLY_CERTIFICATE_TEXT,
  POLY_DIPLOMA_TEXT,
} from "./fixtures/polytechnicTranscripts.js";
import { heuristicsEducationFromText } from "./heuristics.js";
import {
  awardLevelFromTitle,
  awardNameOf,
  checkLevelMismatch,
  educationResultFlags,
  LEVEL_MISMATCH_FLAG,
} from "./levelMismatch.js";
import { resolveLevelSources } from "./levelSources.js";
import type { EducationExtract } from "./schemas.js";

const extractOf = (over: Partial<EducationExtract>): EducationExtract => ({
  degreeTitle: null,
  institution: null,
  country: null,
  start: null,
  end: null,
  statedDuration: null,
  multipleBachelors: false,
  ...over,
});

describe("backup reader: polytechnic transcript layout", () => {
  it("reads the National Certificate title and the issuer", () => {
    const e = heuristicsEducationFromText(POLY_CERTIFICATE_TEXT);
    assert.equal(e.degreeTitle, "NATIONAL CERTIFICATE IN CIVIL ENGINEERING");
    assert.equal(e.institution, "HARARE POLYTECHNIC");
  });

  it("reads the National Diploma title and the issuer", () => {
    const e = heuristicsEducationFromText(POLY_DIPLOMA_TEXT);
    assert.equal(e.degreeTitle, "NATIONAL DIPLOMA IN CIVIL ENGINEERING");
    assert.equal(e.institution, "HARARE POLYTECHNIC");
  });

  it("does not take the ministry line as the institution", () => {
    const e = heuristicsEducationFromText(
      ["MINISTRY OF HIGHER EDUCATION COLLEGE SECTION", "SAMPLE COLLEGE OF TECHNOLOGY", "AWARD GRANTED: Certificate in Plumbing"].join("\n"),
    );
    assert.equal(e.institution, "SAMPLE COLLEGE OF TECHNOLOGY");
    assert.equal(e.degreeTitle, "Certificate in Plumbing");
  });

  it("accepts a lower-case polytechnic name in the letterhead", () => {
    const e = heuristicsEducationFromText(
      ["sample city polytechnic", "Programme Attended: National Diploma in Accountancy"].join("\n"),
    );
    assert.equal(e.institution, "sample city polytechnic");
    assert.equal(e.degreeTitle, "National Diploma in Accountancy");
  });
});

describe("award level of a title", () => {
  it("classifies printed awards", () => {
    assert.equal(awardLevelFromTitle("NATIONAL CERTIFICATE IN CIVIL ENGINEERING"), "certificate");
    assert.equal(awardLevelFromTitle("National Diploma in Civil Engineering"), "diploma");
    assert.equal(awardLevelFromTitle("Advanced Diploma of Information Technology"), "advanced_diploma");
    assert.equal(awardLevelFromTitle("Bachelor of Technology in Civil Engineering"), "bachelor");
    assert.equal(awardLevelFromTitle("Master of Science in Data Science"), "master");
    assert.equal(awardLevelFromTitle("Graduate Diploma of Engineering"), null);
    assert.equal(awardLevelFromTitle("Civil Engineering"), null);
  });

  it("shortens the award name for the note", () => {
    assert.equal(awardNameOf("NATIONAL DIPLOMA IN CIVIL ENGINEERING"), "National Diploma");
    assert.equal(awardNameOf("National Certificate in Civil Engineering"), "National Certificate");
  });
});

describe("level mismatch: single award at another level", () => {
  const groqData = (title: string) => ({
    sources: [
      {
        documentId: "doc-cert",
        documentType: "TRANSCRIPT",
        degreeTitle: title,
        institution: "HARARE POLYTECHNIC",
        country: "Zimbabwe",
        start: null,
        end: null,
        statedDuration: null,
        multipleBachelors: false,
        confidence: 0.9,
      },
    ],
  });

  it("keeps the values, flags the mismatch, and is not a fallback", () => {
    const r = resolveLevelSources({
      labeled: [{ documentId: "doc-cert", documentType: "TRANSCRIPT", text: POLY_CERTIFICATE_TEXT }],
      data: groqData("NATIONAL CERTIFICATE IN CIVIL ENGINEERING"),
      degreeLevel: "bachelor",
      groqFailed: false,
    });
    assert.equal(r.fallback, false);
    assert.equal(r.sources[0]!.extract.degreeTitle, "NATIONAL CERTIFICATE IN CIVIL ENGINEERING");
    assert.equal(r.sources[0]!.extract.institution, "HARARE POLYTECHNIC");
    assert.equal(r.levelMismatches.length, 1);
    assert.equal(r.levelMismatches[0]!.detectedLevel, "certificate");
    assert.equal(r.levelMismatches[0]!.awardName, "National Certificate");
    const flags = educationResultFlags([], r.fallback, r.levelMismatches);
    assert.deepEqual(flags, [LEVEL_MISMATCH_FLAG, `${LEVEL_MISMATCH_FLAG}:certificate`]);
    assert.ok(!flags.includes("heuristics_fallback"));
  });

  it("diploma filed under bachelor: values kept, mismatch diploma", () => {
    const r = resolveLevelSources({
      labeled: [{ documentId: "doc-cert", documentType: "TRANSCRIPT", text: POLY_DIPLOMA_TEXT }],
      data: groqData("NATIONAL DIPLOMA IN CIVIL ENGINEERING"),
      degreeLevel: "bachelor",
      groqFailed: false,
    });
    assert.equal(r.fallback, false);
    assert.equal(r.levelMismatches[0]?.detectedLevel, "diploma");
  });

  it("same level: no mismatch", () => {
    const r = resolveLevelSources({
      labeled: [{ documentId: "doc-cert", documentType: "TRANSCRIPT", text: POLY_DIPLOMA_TEXT }],
      data: groqData("NATIONAL DIPLOMA IN CIVIL ENGINEERING"),
      degreeLevel: "diploma",
      groqFailed: false,
    });
    assert.equal(r.levelMismatches.length, 0);
    assert.deepEqual(educationResultFlags([], r.fallback, r.levelMismatches), []);
  });

  it("all-null Groq fields are filled from the text, not a fallback", () => {
    const r = resolveLevelSources({
      labeled: [{ documentId: "doc-cert", documentType: "TRANSCRIPT", text: POLY_CERTIFICATE_TEXT }],
      data: { sources: [{ documentId: "doc-cert", documentType: "TRANSCRIPT" }] },
      degreeLevel: "bachelor",
      groqFailed: false,
    });
    assert.equal(r.fallback, false);
    assert.equal(r.sources[0]!.extract.degreeTitle, "NATIONAL CERTIFICATE IN CIVIL ENGINEERING");
    assert.equal(r.sources[0]!.extract.institution, "HARARE POLYTECHNIC");
    assert.equal(r.levelMismatches[0]?.detectedLevel, "certificate");
  });

  it("Groq failure is still a fallback, and the backup read is level-checked", () => {
    const r = resolveLevelSources({
      labeled: [{ documentId: "doc-cert", documentType: "TRANSCRIPT", text: POLY_CERTIFICATE_TEXT }],
      data: { sources: [] },
      degreeLevel: "bachelor",
      groqFailed: true,
    });
    assert.equal(r.fallback, true);
    assert.equal(r.sources[0]!.extract.degreeTitle, "NATIONAL CERTIFICATE IN CIVIL ENGINEERING");
    assert.equal(r.levelMismatches[0]?.detectedLevel, "certificate");
  });
});

describe("level mismatch: strict cases", () => {
  it("multi-award document drops the other-level title, no mismatch", () => {
    const r = checkLevelMismatch({
      documentId: "doc-multi",
      documentType: "TRANSCRIPT",
      targetLevel: "bachelor",
      text: MULTI_AWARD_TEXT,
      extract: extractOf({ degreeTitle: "Diploma in Civil Engineering", institution: "SAMPLE UNIVERSITY" }),
    });
    assert.equal(r.mismatch, null);
    assert.equal(r.extract.degreeTitle, null);
    assert.equal(r.extract.institution, "SAMPLE UNIVERSITY");
  });

  it("CV entries are never level-mismatch reads", () => {
    const extract = extractOf({ degreeTitle: "Diploma in Civil Engineering" });
    const r = checkLevelMismatch({
      documentId: "doc-cv",
      documentType: "CV",
      targetLevel: "bachelor",
      text: "Diploma in Civil Engineering, Sample College",
      extract,
    });
    assert.equal(r.mismatch, null);
    assert.equal(r.extract, extract);
  });
});
