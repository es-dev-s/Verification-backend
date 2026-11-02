import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { degreeReaderWindow, fillEmptyEducationFields } from "./degreeReaderText.js";

const blank = {
  degreeTitle: null,
  institution: null,
  country: null,
  start: null,
  end: null,
  statedDuration: null,
  multipleBachelors: false,
};

describe("degree reader window", () => {
  it("keeps a short transcript whole", () => {
    const text = "Qualification: Advanced Diploma of Information Technology";
    assert.equal(degreeReaderWindow(text), text);
  });

  it("keeps the first page and the last page and drops the unit pages", () => {
    const text = [
      "--- page 1 ---",
      "Qualification: Bachelor of Engineering",
      "--- page 2 ---",
      "Unit ICTNWK546 Network security",
      "--- page 3 ---",
      "DEGREES AWARDED",
      "Bachelor of Engineering",
    ].join("\n");
    const window = degreeReaderWindow(text);
    assert.match(window, /Qualification: Bachelor of Engineering/);
    assert.match(window, /DEGREES AWARDED/);
    assert.equal(window.includes("ICTNWK546"), false);
    assert.match(window, /later pages omitted/);
  });

  it("keeps the start and the end when there are no page markers", () => {
    const head = "Qualification: Diploma of Engineering\n";
    const middle = "X".repeat(8_000);
    const tail = "\nDEGREES AWARDED\nDiploma of Engineering";
    const window = degreeReaderWindow(head + middle + tail);
    assert.match(window, /^Qualification: Diploma of Engineering/);
    assert.match(window, /DEGREES AWARDED/);
    assert.match(window, /later pages omitted/);
    assert.ok(window.length < head.length + middle.length + tail.length);
  });
});

describe("empty education fields", () => {
  it("fills only the title and leaves the other Groq fields", () => {
    const extract = {
      ...blank,
      institution: "Bella College",
      country: "Australia",
    };
    const filled = fillEmptyEducationFields(
      extract,
      "Qualification: ICT60220 Advanced Diploma of Information Technology\nInstitution: Other College",
    );
    assert.match(filled.degreeTitle ?? "", /Advanced Diploma of Information Technology/i);
    assert.equal(filled.institution, "Bella College");
    assert.equal(filled.country, "Australia");
  });

  it("fills an empty institution and keeps the Groq title", () => {
    const extract = {
      ...blank,
      degreeTitle: "Bachelor of Civil Engineering",
    };
    const filled = fillEmptyEducationFields(
      extract,
      "Qualification: Bachelor of Science\nInstitution: Middle East Technical University\nCountry: Turkey",
    );
    assert.equal(filled.degreeTitle, "Bachelor of Civil Engineering");
    assert.match(filled.institution ?? "", /Middle East Technical University/i);
    assert.equal(filled.country, "Turkey");
  });

  it("keeps a title Groq already returned", () => {
    const extract = {
      ...blank,
      degreeTitle: "Bachelor of Civil Engineering",
      institution: "METU",
    };
    const filled = fillEmptyEducationFields(
      extract,
      "Qualification: Bachelor of Science\nInstitution: Other University\nBranch: Physics",
    );
    assert.equal(filled.degreeTitle, "Bachelor of Civil Engineering");
    assert.equal(filled.institution, "METU");
  });
});
