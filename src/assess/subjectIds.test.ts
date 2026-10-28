import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkSubjectIdLinks,
  loadRubric,
  warnSubjectIdMismatches,
  type SubjectIdLinkReport,
} from "./loadRubric.js";

const here = dirname(fileURLToPath(import.meta.url));
const lib = resolve(here, "../lib");
const rubrics = JSON.parse(readFileSync(resolve(lib, "anzsco-verification-rubrics.json"), "utf8"));
const subjects = JSON.parse(readFileSync(resolve(lib, "anzsco_subjects.json"), "utf8"));

type Row = { id?: string; name?: string; label?: string };
function rubricRows(o: any): Row[] {
  return [
    ...(o.tier1?.subjects ?? []),
    ...(o.tier2?.core ?? []),
    ...(o.tier2?.optional ?? []),
    ...(o.tier3?.gate ? [o.tier3.gate] : []),
    ...(o.tier3?.supporting ?? []),
    ...(o.tier3?.optional ?? []),
  ];
}
const academic = rubrics.occupations.filter((o: any) => o.flow === "academic_3_tier");

describe("subject heading ids", () => {
  it("every academic rubric heading has a unique <code>-T<tier>.<n> id", () => {
    for (const o of academic) {
      const ids = rubricRows(o).map((r) => r.id);
      for (const id of ids) {
        assert.match(String(id), new RegExp(`^${o.anzsco}-T[123]\\.(G|O?\\d+)$`), `${o.id}: ${id}`);
      }
      assert.equal(new Set(ids).size, ids.length, `duplicate id in ${o.id}`);
    }
  });

  it("every academic occupation has its own subjects-file entry (233999 split by occupationId)", () => {
    for (const o of academic) {
      const entries = subjects.filter((e: any) => e.occupationId === o.id);
      assert.equal(entries.length, 1, o.id);
      assert.equal(entries[0].anzscoCode, String(o.anzsco), o.id);
    }
    const auto = subjects.find((e: any) => e.occupationId === "automation-control-engineer");
    assert.equal(auto.anzscoCode, "233999");
  });

  it("the six previously missing occupations are built from rubric headings only", () => {
    for (const id of [
      "geotechnical-engineer", "structural-engineer", "transport-engineer",
      "petroleum-engineer", "environmental-engineer", "naval-architect",
    ]) {
      const o = academic.find((x: any) => x.id === id);
      const e = subjects.find((x: any) => x.occupationId === id);
      const sheetRows = Object.values(e.groups).flatMap((g: any) => g.subjects);
      const rows = rubricRows(o);
      assert.equal(sheetRows.length, rows.length, id);
      for (const r of rows) {
        const s = sheetRows.find((x: any) => x.id === r.id) as any;
        assert.ok(s, `${id}: ${r.id}`);
        assert.equal(s.name, r.name ?? r.label);
        assert.deepEqual(s.variants, [r.name ?? r.label]);
      }
    }
  });

  it("links variants by id even when the wording differs (Civil Structural Analysis)", () => {
    const civil = loadRubric("civil-engineer");
    const row = civil.tiers.tier2.subjects.find((s) =>
      s.name.startsWith("Structural Analysis / Structural Design"),
    )!;
    const sheet = subjects
      .find((e: any) => e.occupationId === "civil-engineer")
      .groups.tier2_core.subjects.find((s: any) => s.name.startsWith("Structural Analysis/ Structural Design"));
    const rubricRow = academic
      .find((o: any) => o.id === "civil-engineer")
      .tier2.core.find((s: any) => s.name === row.name);
    assert.ok(sheet, "subjects-file row");
    assert.equal(sheet.id, rubricRow.id, "paired by id");
    assert.notEqual(sheet.name, row.name, "names differ, so only the id can join them");
    assert.ok(row.variants.length >= 64, `got ${row.variants.length}`);
    for (const v of sheet.variants) assert.ok(row.variants.includes(v.trim()), v);
  });

  it("does not link by name: an unpaired subjects-file heading adds no variants", () => {
    const ind = loadRubric("industrial-engineer");
    const row = ind.tiers.tier2.subjects.find((s) =>
      s.name.startsWith("Quality Control / Statistical Quality Control"),
    )!;
    const sheet = subjects
      .find((e: any) => e.occupationId === "industrial-engineer")
      .groups.tier2_core.subjects.find((s: any) => s.name === "Quality Management / Quality Engineering");
    assert.match(sheet.id, /-T2\.X\d+$/);
    for (const v of sheet.variants) assert.ok(!row.variants.includes(v), v);
  });

  it("re-running the pairing script assigns no new ids (files in sync)", () => {
    const script = resolve(here, "../../scripts/pairSubjectIds.ts");
    const out = execFileSync(process.execPath, ["--import", "tsx", script], {
      cwd: resolve(here, "../.."),
      encoding: "utf8",
    });
    const report = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    assert.equal(report.headingsGivenIds, 0);
    assert.equal(report.exact + report.wording, 0);
    assert.deepEqual(report.addedOccupations, []);
  });
});

describe("startup id check", () => {
  it("reports ids present on only one side, per occupation", () => {
    const report = checkSubjectIdLinks(
      {
        flows: {},
        occupations: [
          {
            id: "demo", anzsco: "999999", title: "Demo", flow: "academic_3_tier",
            tier1: { total: 2, thresholds: {}, subjects: [{ id: "999999-T1.1", name: "A" }, { id: "999999-T1.2", name: "B" }] },
            tier2: { total: 0, thresholds: {}, core: [{ name: "No id" }] },
          },
        ],
      },
      [
        {
          anzscoCode: "999999", title: "Demo", occupationId: "demo",
          groups: { tier1: { subjects: [{ id: "999999-T1.1", name: "A" }, { id: "999999-T1.X1", name: "Z" }] } },
        },
      ],
    );
    assert.equal(report.length, 1);
    assert.deepEqual(report[0]!.missingInSubjects, ["999999-T1.2"]);
    // Subjects-only "X" headings are by design: counted, not reported as a mismatch.
    assert.deepEqual(report[0]!.missingInRubric, []);
    assert.equal(report[0]!.subjectsOnly, 1);
    assert.equal(report[0]!.rubricRowsWithoutId, 1);
    assert.equal(report[0]!.noSubjectsEntry, false);
  });

  it("warns with console-style lines and never throws", () => {
    const lines: string[] = [];
    const report: SubjectIdLinkReport[] = [
      { occupationId: "ok", anzsco: "1", noSubjectsEntry: false, rubricRowsWithoutId: 0, missingInSubjects: [], missingInRubric: [], subjectsOnly: 0 },
      { occupationId: "bad", anzsco: "2", noSubjectsEntry: true, rubricRowsWithoutId: 0, missingInSubjects: ["2-T1.1"], missingInRubric: [], subjectsOnly: 0 },
    ];
    const n = warnSubjectIdMismatches(report, (m) => lines.push(m));
    assert.equal(n, 1);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^\[rubric ids\] bad \(2\): no anzsco_subjects\.json entry; only in rubrics: 2-T1\.1$/);
  });

  it("real files: every academic occupation joins a subjects entry and all rubric rows have ids", () => {
    for (const r of checkSubjectIdLinks()) {
      assert.equal(r.noSubjectsEntry, false, r.occupationId);
      assert.equal(r.rubricRowsWithoutId, 0, r.occupationId);
    }
  });
});
