import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listedSubjectCount } from "./transcriptData.js";
import { titleNamesEngineering } from "./route.js";

describe("transcript and assessment subject list", () => {
  it("counts Islamiat and Pakistan Studies on both screens when a later year repeats it", () => {
    const rows = [
      { name: "Islamiat and Pakistan Studies", isRepeat: true },
      { name: "English", isRepeat: false },
    ];
    assert.equal(listedSubjectCount(rows), rows.length);
    assert.equal(rows.filter((row) => !row.isRepeat).length, 1);
  });
});

describe("engineering-titled checkbox", () => {
  it("uses the same title-names-engineering rule the assessment prints", () => {
    assert.equal(titleNamesEngineering("DAE Electrical Technology"), true);
    assert.equal(titleNamesEngineering("Diploma of Associate Engineer"), true);
    assert.equal(titleNamesEngineering("Bachelor of Business Administration"), false);
    assert.equal(
      titleNamesEngineering("Bachelor of Science", "Electrical Engineering"),
      true,
    );
  });
});
