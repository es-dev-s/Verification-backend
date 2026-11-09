import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessExtractedSubjects } from "./assessCase.js";
import type { QualificationInfo } from "./qualificationCheck.js";
import type { ExtractedSubjectRow } from "./schemas.js";
import { scoreTelecomGroup } from "./telecomGroup.js";

const FOUNDATIONAL = [
  ["BSBCRT611", "Apply critical thinking for complex problem solving"],
  ["BSBTWK502", "Manage team effectiveness"],
  ["BSBXCS402", "Promote workplace cyber security awareness and best practices"],
  ["ICTICT608", "Interact with clients on a business level"],
  ["ICTICT618", "Manage IP, ethics and privacy in ICT environments"],
  ["ICTSAD609", "Plan and monitor business analysis activities in an ICT environment"],
] as const;

const GROUP_G = [
  ["ICTNPL413", "Evaluate networking regulations and legislation for the telecommunications industry"],
  ["ICTNWK612", "Plan and manage troubleshooting advanced integrated IP networks"],
  ["ICTPMG613", "Manage ICT project planning"],
  ["ICTTEN615", "Manage network traffic"],
  ["ICTTEN622", "Produce ICT network architecture designs"],
] as const;

function row(code: string, title: string, codeField: string | null = code): ExtractedSubjectRow {
  return {
    name: codeField ? `${code} - ${title}` : title,
    code: codeField,
    credits: null,
    grade: null,
    yearOrSemester: null,
    qualification: "advanced_diploma",
    sourceSnippet: null,
    isRepeat: false,
  };
}

function units(list: readonly (readonly [string, string])[], drop: string[] = []): ExtractedSubjectRow[] {
  return list.filter(([code]) => !drop.includes(code)).map(([code, title]) => row(code, title));
}

function ict(title = "ICT60220 Advanced Diploma of Information Technology"): QualificationInfo {
  return {
    level: "advanced_diploma",
    title,
    countedYearsOverride: 2,
    engineeringShareOverride: 1,
  };
}

describe("telecommunications group", () => {
  it("counts a unit that sits in two groups once", () => {
    const cards = scoreTelecomGroup([]);
    const field = cards.find((c) => c.rubric.anzscoCode === "313212")!;
    const officer = cards.find((c) => c.rubric.anzscoCode === "313214")!;
    assert.ok(field.scored.coreExpected < 4 + 6 + 4 + 3 + 4 + 4 + 5);
    assert.equal(field.scored.coreExpected, officer.scored.coreExpected);
    assert.equal(field.status, "review");
  });

  it("matches a unit by name when the transcript line has no code", () => {
    const rows = [
      ...units(FOUNDATIONAL),
      ...GROUP_G.slice(0, 4).map(([code, title]) => row(code, title)),
      row("ICTTEN622", "Produce ICT network architecture designs", null),
    ];
    const cards = scoreTelecomGroup(rows);
    const planner = cards.find((c) => c.rubric.anzscoCode === "313213")!;
    assert.equal(planner.status, "recommended");
    assert.equal(planner.scored.coreMatched, 5);
  });

  it("does not apply when the qualification is not ICT60220", () => {
    const q: QualificationInfo = {
      level: "advanced_diploma",
      title: "Advanced Diploma of Engineering",
      countedYearsOverride: 2,
      engineeringShareOverride: 1,
    };
    const res = assessExtractedSubjects(units(FOUNDATIONAL), { qualifications: [q] });
    assert.equal(res.gate1?.result, "open");
    assert.ok(res.gate1?.tracks.some((t) => t.track === "engineering_associate" && t.open));
    assert.equal((res.candidates ?? []).some((c) => c.suggestionStatus), false);
  });

  it("does not apply when Engineering Associate is closed", () => {
    const q: QualificationInfo = {
      level: "bachelor",
      title: "Bachelor of Engineering (Mechanical)",
      countedYearsOverride: 4,
    };
    const res = assessExtractedSubjects(
      units([...FOUNDATIONAL, ...GROUP_G]).map((r) => ({ ...r, qualification: "bachelor" })),
      { qualifications: [q] },
    );
    assert.equal(res.gate1?.tracks.find((t) => t.track === "engineering_associate")?.open, false);
    assert.equal((res.candidates ?? []).some((c) => c.suggestionStatus), false);
  });

  it("flags missing foundational units and recommends none of the three", () => {
    const res = assessExtractedSubjects(units(FOUNDATIONAL, ["BSBTWK502"]), { qualifications: [ict()] });
    assert.equal(res.recommended, false);
    assert.equal(res.anzscoCode, null);
    const telecom = (res.candidates ?? []).filter((c) => c.suggestionStatus);
    assert.deepEqual(
      telecom.map((c) => c.anzscoCode),
      ["313213", "313212", "313214"],
    );
    assert.ok(telecom.every((c) => c.suggestionStatus === "review" && c.recommended === false));
    assert.match(telecom[0]!.qualificationNotes?.[0] ?? "", /BSBTWK502/);
  });

  it("ranks Network Planner first when Group G is complete, with the other two joint", () => {
    const res = assessExtractedSubjects(units([...FOUNDATIONAL, ...GROUP_G]), {
      qualifications: [ict("ICT60220 Advanced Diploma of Information Technology")],
    });
    const telecom = (res.candidates ?? []).filter((c) => c.suggestionStatus);
    assert.deepEqual(
      telecom.map((c) => [c.anzscoCode, c.suggestionStatus, c.recommended]),
      [
        ["313213", "recommended", true],
        ["313212", "eligible", false],
        ["313214", "eligible", false],
      ],
    );
    assert.equal(res.anzscoCode, "313213");
    assert.equal(res.recommended, true);
    assert.equal(telecom[1]!.confidenceScore, telecom[2]!.confidenceScore);
  });

  it("rejects Network Planner when Group G is incomplete, even if the title says telecommunications", () => {
    const res = assessExtractedSubjects(units([...FOUNDATIONAL, ...GROUP_G], ["ICTTEN622"]), {
      qualifications: [
        ict("ICT60220 Advanced Diploma of Information Technology (Telecommunications Network Engineering)"),
      ],
    });
    const telecom = (res.candidates ?? []).filter((c) => c.suggestionStatus);
    assert.deepEqual(
      telecom.map((c) => c.suggestionStatus),
      ["eligible", "eligible", "rejected"],
    );
    assert.equal(telecom[2]!.anzscoCode, "313213");
    assert.equal(telecom[0]!.confidenceScore, telecom[1]!.confidenceScore);
    assert.ok(telecom[0]!.confidenceScore > telecom[2]!.confidenceScore);
    assert.equal(res.recommended, false);
    assert.match(telecom[2]!.qualificationNotes?.[0] ?? "", /ICTTEN622/);
  });

  it("reads ICT60220 from the transcript when the title omits the code", () => {
    const q: QualificationInfo = {
      ...ict("Advanced Diploma of Information Technology"),
      texts: ["Qualification: ICT60220 Advanced Diploma of Information Technology"],
    };
    const res = assessExtractedSubjects(units([...FOUNDATIONAL, ...GROUP_G]), {
      qualifications: [q],
      transcriptTexts: q.texts,
    });
    assert.equal(res.candidates?.find((c) => c.anzscoCode === "313213")?.suggestionStatus, "recommended");
  });
});
