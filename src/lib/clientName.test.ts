import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clientNameFromCvText,
  clientNameFromTranscriptText,
  sanitizeClientName,
} from "./clientName.js";
import { resolveClientName } from "./clientSummary.js";
import { mergeExperienceParts } from "../parse/groqFormParse.js";
import { experienceExtractSchema } from "../parse/schemas.js";

test("sanitizeClientName keeps person-like names and tidies case", () => {
  assert.equal(sanitizeClientName("Jane Doe"), "Jane Doe");
  assert.equal(sanitizeClientName("JANE MARY DOE"), "Jane Mary Doe");
  assert.equal(sanitizeClientName("Name: Ram Bahadur Thapa"), "Ram Bahadur Thapa");
  assert.equal(sanitizeClientName("Er. Sita Sharma"), "Sita Sharma");
  assert.equal(sanitizeClientName("Mr. John O'Neil-Smith"), "John O'Neil-Smith");
  assert.equal(sanitizeClientName("Sri Ram Karki"), "Sri Ram Karki");
});

test("sanitizeClientName rejects headings, roles, contact lines and single words", () => {
  for (const bad of [
    "Curriculum Vitae",
    "CURRICULUM VITAE",
    "Resume",
    "Résumé",
    "CV",
    "Personal Details",
    "Civil Engineer",
    "Site Supervisor",
    "Kathmandu, Nepal",
    "jane.doe@example.com",
    "+977 9800000000",
    "Rahna",
    "Tribhuvan University",
    "Career Objective",
    "",
    null,
  ]) {
    assert.equal(sanitizeClientName(bad), null, String(bad));
  }
});

test("clientNameFromCvText reads the name under a CV heading, or a Name: line", () => {
  assert.equal(
    clientNameFromCvText("CURRICULUM VITAE\nJANE DOE\nCivil Engineer\nKathmandu, Nepal"),
    "Jane Doe",
  );
  assert.equal(
    clientNameFromCvText("Resume\nPersonal Details\nName: Hari Prasad Adhikari\nDOB: 1990-01-01"),
    "Hari Prasad Adhikari",
  );
  assert.equal(clientNameFromCvText("CURRICULUM VITAE\nCareer Objective\nTo work…"), null);
  assert.equal(clientNameFromCvText(""), null);
  assert.equal(clientNameFromCvText(null), null);
});

test("clientNameFromTranscriptText reads Student Name and similar labels", () => {
  assert.equal(
    clientNameFromTranscriptText(
      "HEXCO\nTRANSCRIPT OF ACADEMIC RECORD\nStudent Name: Jane Doe\nProgramme: NATIONAL DIPLOMA in CIVIL ENGINEERING",
    ),
    "Jane Doe",
  );
  assert.equal(
    clientNameFromTranscriptText("Name of Student: Ram Bahadur Thapa\nInstitution: Some College"),
    "Ram Bahadur Thapa",
  );
  assert.equal(
    clientNameFromTranscriptText("Candidate's Name: Sita Sharma\nCourse: Diploma"),
    "Sita Sharma",
  );
  assert.equal(
    clientNameFromTranscriptText("Full Name: Hari Prasad Adhikari\nAward: Certificate"),
    "Hari Prasad Adhikari",
  );
  assert.equal(
    clientNameFromTranscriptText("Name: Cem Ergen\nTRANSCRIPT OF ACADEMIC RECORD"),
    "Cem Ergen",
  );
});

test("clientNameFromTranscriptText rejects degree titles and institution-only headers", () => {
  assert.equal(
    clientNameFromTranscriptText("NATIONAL DIPLOMA in CIVIL ENGINEERING\nHEXCO\nYear 1"),
    null,
  );
  assert.equal(
    clientNameFromTranscriptText(
      "TRANSCRIPT OF ACADEMIC RECORD\nUNIVERSITY OF EXAMPLE\nFaculty of Engineering",
    ),
    null,
  );
  assert.equal(
    clientNameFromTranscriptText("Name of Institution: Harare Polytechnic\nStudent No: 123"),
    null,
  );
  assert.equal(clientNameFromTranscriptText(""), null);
  assert.equal(clientNameFromTranscriptText(null), null);
});

test("resolveClientName: stored text name first, then the old file-name fallback", () => {
  assert.deepEqual(
    resolveClientName({ caseId: "c123456", storedName: "Jane Doe", cvFileName: "7. Rahna - cv.docx" }),
    { name: "Jane Doe", source: "stored" },
  );
  // Legacy cvTextName alias still works
  assert.deepEqual(
    resolveClientName({ caseId: "c123456", cvTextName: "Jane Doe", cvFileName: "7. Rahna - cv.docx" }),
    { name: "Jane Doe", source: "stored" },
  );
  assert.deepEqual(
    resolveClientName({ caseId: "c123456", storedName: null, cvFileName: "7. Rahna - cv.docx" }),
    { name: "Rahna", source: "cv_file" },
  );
  assert.deepEqual(
    resolveClientName({ caseId: "c123456", cvFileName: "cv.pdf", firstFileName: "Cem_Ergen_Transcript.pdf" }),
    { name: "Cem Ergen", source: "document_file" },
  );
  assert.deepEqual(
    resolveClientName({
      caseId: "c123456",
      cvFileName: null,
      firstFileName: "NATIONAL_DIPLOMA_CIVIL_ENGINEERING.pdf",
    }),
    { name: "Client 123456", source: "case_id" },
  );
  assert.deepEqual(resolveClientName({ caseId: "abc123456" }), {
    name: "Client 123456",
    source: "case_id",
  });
});

test("experience read: applicantName is optional and merged from the first part", () => {
  assert.ok(experienceExtractSchema.safeParse({ rows: [] }).success);
  const merged = mergeExperienceParts([
    { applicantName: "Jane Doe", rows: [] },
    { applicantName: "A Referee", rows: [{ employer: "X", title: "Y", start: null, end: null, domainMatch: null }] },
  ]);
  assert.equal(merged.applicantName, "Jane Doe");
  assert.equal((merged.rows as unknown[]).length, 1);
  assert.equal(mergeExperienceParts([{ rows: [] }]).applicantName, null);
});
