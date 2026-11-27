import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveAwardDetails, fieldOfStudyFromTitle } from "../assess/awardDetails.js";
import { heuristicsEducationFromText } from "./heuristics.js";
import { mergeEducation } from "./mergeEducation.js";
import { sanitizeDegreeTitle } from "./sanitizeExtracted.js";
import {
  alignResultCardSources,
  completionYearFromSources,
} from "./resultCardEducation.js";
import type { PerSourceEducation } from "./schemas.js";

function card(year: "FIRST" | "SECOND" | "THIRD", exam: number): string {
  return [
    "PUNJAB BOARD OF TECHNICAL EDUCATION, LAHORE.",
    "RESULT CARD",
    `DIPLOMA OF ASSOCIATE ENGINEER, FIRST ANNUAL EXAMINATION, ${exam} Name of the Candidate`,
    "Registration No. 214-1402-08127",
    `ELECTRICAL TECHNOLOGY (${year} YEAR)`,
    "Detail is as under:",
    "Sr. No | Subjects / Papers | Maximum Marks Marks Obtained",
    "1 GEN111 - ISLAMIAT AND PAKISTAN STUDIES | 100 | 70",
  ].join("\n");
}

function source(id: string, text: string): PerSourceEducation {
  return {
    documentId: id,
    documentType: "CERTIFICATE",
    extract: heuristicsEducationFromText(text),
  };
}

describe("PBTE result card education read", () => {
  it("strips the exam sitting and candidate name from the award line", () => {
    assert.equal(
      sanitizeDegreeTitle(
        "DIPLOMA OF ASSOCIATE ENGINEER, FIRST ANNUAL EXAMINATION, 2015 Name of the Candidate",
      ),
      "DIPLOMA OF ASSOCIATE ENGINEER",
    );
  });

  it("reads DAE Electrical Technology and the technology line as the field", () => {
    const text = card("FIRST", 2015);
    const extract = heuristicsEducationFromText(text);
    assert.equal(extract.degreeTitle, "DAE Electrical Technology");
    assert.equal(extract.degreeTitle?.includes("Name of the Candidate"), false);
    assert.equal(extract.end, "2015");
    assert.equal(fieldOfStudyFromTitle(extract.degreeTitle), "Electrical Technology");
    assert.equal(
      deriveAwardDetails({
        degreeLevel: "diploma",
        title: "Diploma of Associate Engineer",
        texts: [text],
      }).fieldOfStudy,
      "Electrical Technology",
    );
  });

  it("merges 2015, 2016 and 2017 cards of one registration without a title conflict", () => {
    const labeled = [
      { id: "y1", text: card("FIRST", 2015) },
      { id: "y2", text: card("SECOND", 2016) },
      { id: "y3", text: card("THIRD", 2017) },
    ];
    const aligned = alignResultCardSources(
      labeled.map((row) => source(row.id, row.text)),
      new Map(labeled.map((row) => [row.id, row.text])),
    );
    const merged = mergeEducation(aligned);
    assert.equal(merged.fields.degreeTitle.value, "DAE Electrical Technology");
    assert.equal(merged.fields.degreeTitle.conflict, false);
    assert.equal(merged.flags.includes("conflict:degreeTitle"), false);
    assert.equal(
      completionYearFromSources(
        aligned.map((row) => ({ documentType: row.documentType, end: row.extract.end })),
      ),
      2017,
    );
    assert.equal(aligned[0]!.extract.statedDuration, "3 years");
  });

  it("does not treat yearly examination titles as conflicting awards", () => {
    const titled = (year: number) =>
      `DIPLOMA OF ASSOCIATE ENGINEER, FIRST ANNUAL EXAMINATION, ${year} Name of the Candidate`;
    const row = (id: string, year: number): PerSourceEducation => ({
      documentId: id,
      documentType: "CERTIFICATE",
      extract: {
        ...heuristicsEducationFromText("unused"),
        degreeTitle: titled(year),
      },
    });
    const merged = mergeEducation([row("a", 2015), row("b", 2016), row("c", 2017)]);
    assert.equal(merged.fields.degreeTitle.conflict, false);
    assert.equal(merged.fields.degreeTitle.value, titled(2015));
  });
});
