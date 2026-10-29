import assert from "node:assert/strict";
import { test } from "node:test";
import { clientNameFromCvText, sanitizeClientName } from "./clientName.js";
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

test("resolveClientName: CV text name first, then the old file-name fallback", () => {
  assert.deepEqual(
    resolveClientName({ caseId: "c123456", cvTextName: "Jane Doe", cvFileName: "7. Rahna - cv.docx" }),
    { name: "Jane Doe", source: "cv_text" },
  );
  assert.deepEqual(
    resolveClientName({ caseId: "c123456", cvTextName: null, cvFileName: "7. Rahna - cv.docx" }),
    { name: "Rahna", source: "cv_file" },
  );
  assert.deepEqual(
    resolveClientName({ caseId: "c123456", cvFileName: "cv.pdf", firstFileName: "Cem_Ergen_Transcript.pdf" }),
    { name: "Cem Ergen", source: "document_file" },
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
