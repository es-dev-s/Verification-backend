/**
 * Give every subject heading a fixed id and pair headings across
 *   src/lib/anzsco-verification-rubrics.json  (rubric rows: the source of truth)
 *   src/lib/anzsco_subjects.json              (naming-variant sheet rows)
 *
 * Id scheme  <anzscoCode>-T<tier>.<n>
 *   T1.<n>   Tier 1 rows, in rubric order (expected, optional and contextual rows share one sequence)
 *   T2.<n>   Tier 2 core rows            T2.O<n>  Tier 2 optional rows
 *   T3.G     Tier 3 gate (project/thesis) T3.<n>   Tier 3 supporting rows   T3.O<n>  Tier 3 optional rows
 *   T<k>.X<n> heading that exists only in anzsco_subjects.json (no confident rubric counterpart yet)
 * Ids are unique within one occupation. ANZSCO 233999 is shared by two occupations, so the
 * subjects-file entry also carries "occupationId" (the rubric occupation "id") and the loader
 * joins on that.
 *
 * Pairing (only confident pairs share an id):
 *   exact    same text ignoring case, spacing and a trailing "(Optional)"
 *   wording  same words after normalising punctuation, "&"/"and", -ise/-ize spelling, word order
 *            and filler words (of / the / for / in / to)
 *   anything weaker is UNCERTAIN: both sides keep separate ids and the pair is written to the
 *   review CSV. To link one after review, set the subjects-file row's id to the rubric id.
 *   When one sheet heading covers several rubric rows, keep the first rubric id in "id" and
 *   list the others in "alsoIds" (loadRubric gives each of them the row's variants).
 *
 * Re-runnable: an id already in the files is never changed; only rows without an id get one.
 *
 * Usage (from api/):  npx tsx scripts/pairSubjectIds.ts [--write] [--csv <path>]
 *   without --write it only reports (dry run).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Row = { id?: string; name?: string; label?: string; [k: string]: unknown };
type Occ = {
  id: string;
  anzsco: string;
  title: string;
  flow: string;
  tier1?: { subjects?: Row[] };
  tier2?: { core?: Row[]; optional?: Row[] };
  tier3?: { gate?: Row; supporting?: Row[]; optional?: Row[] };
};
/** "alsoIds": further rubric ids one sheet heading is linked to (it covers several rubric rows). */
type SubjRow = { id?: string; alsoIds?: string[]; name: string; variants?: string[]; [k: string]: unknown };
type Entry = {
  anzscoCode: string | null;
  title: string;
  occupationId?: string;
  sourceSheet?: string;
  groups?: Record<string, { categoryLabel?: string; subjects?: SubjRow[] }>;
  [k: string]: unknown;
};

const here = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(here, "../src/lib");
const RUBRICS = resolve(libDir, "anzsco-verification-rubrics.json");
const SUBJECTS = resolve(libDir, "anzsco_subjects.json");

const FILLER = new Set(["of", "the", "for", "in", "to", "and", "a", "an"]);

export function stripOptional(s: string): string {
  return s.replace(/\s*\(optional\)\s*$/i, "").trim();
}
export function exactKey(s: string): string {
  return stripOptional(s).toLowerCase().replace(/\s+/g, " ").trim();
}
export function wordTokens(s: string): string[] {
  return stripOptional(s)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/([a-z])i[sz](e|ed|es|ing|ation|ations)\b/g, "$1is$2")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !FILLER.has(w));
}
export function wordingKey(s: string): string {
  return [...new Set(wordTokens(s))].sort().join(" ");
}
function bigrams(s: string): string[] {
  const t = ` ${wordTokens(s).join(" ")} `;
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}
/** Dice coefficient on character bigrams of the normalised words (0..1). */
export function similarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const counts = new Map<string, number>();
  for (const g of A) counts.set(g, (counts.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of B) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      hit++;
      counts.set(g, c - 1);
    }
  }
  return (2 * hit) / (A.length + B.length);
}
/** The pre-Phase-2 loader's loose rule (substring after dropping "/()"): used only to flag rows that lose variants. */
export function legacyLooseMatch(a: string, b: string): boolean {
  const norm = (x: string) => stripOptional(x).toLowerCase().replace(/[/()]/g, " ").replace(/\s+/g, " ").trim();
  const na = norm(a);
  const nb = norm(b);
  return !!na && !!nb && (na === nb || na.includes(nb) || nb.includes(na));
}

export function pairKind(a: string, b: string): "exact" | "wording" | null {
  if (exactKey(a) === exactKey(b)) return "exact";
  const wa = wordingKey(a);
  if (wa && wa === wordingKey(b)) return "wording";
  return null;
}

/** Tier a subjects-file group belongs to (for X ids and the review CSV). */
export function groupTier(groupKey: string, groupKeys: string[]): number {
  const m = /^tier(\d+)/.exec(groupKey);
  if (m) return Math.min(Number(m[1]), 3);
  if (/^partA/.test(groupKey)) return 1;
  if (/^partB/.test(groupKey)) return groupKeys.some((k) => /^tier2/.test(k)) ? 3 : 2;
  return 3;
}

const rowName = (r: Row) => String(r.name ?? r.label ?? "").trim();

type RubricRow = { id: string; name: string; tier: string; row: Row };

/** Rubric rows of one academic occupation, assigning ids where missing. */
export function rubricRows(o: Occ, assign = true): RubricRow[] {
  const code = String(o.anzsco);
  const out: RubricRow[] = [];
  const give = (row: Row, local: string, tier: string) => {
    const full = `${code}-${local}`;
    if (assign && !/^\d+-T/.test(String(row.id ?? ""))) setIdFirst(row, full);
    out.push({ id: String(row.id ?? full), name: rowName(row), tier, row });
  };
  (o.tier1?.subjects ?? []).forEach((r, i) => give(r, `T1.${i + 1}`, `T1 ${String(r.status ?? "expected")}`));
  (o.tier2?.core ?? []).forEach((r, i) => give(r, `T2.${i + 1}`, "T2 core"));
  (o.tier2?.optional ?? []).forEach((r, i) => give(r, `T2.O${i + 1}`, "T2 optional"));
  if (o.tier3?.gate) give(o.tier3.gate, "T3.G", "T3 gate");
  (o.tier3?.supporting ?? []).forEach((r, i) => give(r, `T3.${i + 1}`, "T3 supporting"));
  (o.tier3?.optional ?? []).forEach((r, i) => give(r, `T3.O${i + 1}`, "T3 optional"));
  return out;
}

/** Put "id" first (or overwrite it in place) without reordering other keys. */
function setIdFirst(obj: Record<string, unknown>, id: string) {
  if ("id" in obj) {
    obj.id = id;
    return;
  }
  const rest = { ...obj };
  for (const k of Object.keys(obj)) delete obj[k];
  obj.id = id;
  Object.assign(obj, rest);
}

/** Insert key after `afterKey`, keeping order. */
function setAfter(obj: Record<string, unknown>, key: string, value: unknown, afterKey: string) {
  if (key in obj) {
    obj[key] = value;
    return;
  }
  const entries = Object.entries(obj);
  for (const k of Object.keys(obj)) delete obj[k];
  for (const [k, v] of entries) {
    obj[k] = v;
    if (k === afterKey) obj[key] = value;
  }
  if (!(key in obj)) obj[key] = value;
}

function titleTokens(s: string) {
  return new Set(wordTokens(s).filter((w) => !["engineer", "engineering"].includes(w)));
}

/** Find the subjects-file entry for an occupation (occupationId first, then legacy rules). */
export function findEntry(o: Occ, entries: Entry[]): Entry | undefined {
  const byId = entries.find((e) => e.occupationId === o.id);
  if (byId) return byId;
  const free = entries.filter((e) => !e.occupationId);
  const code = String(o.anzsco);
  const sameCode = free.filter((e) => e.anzscoCode != null && String(e.anzscoCode) === code);
  const rt = titleTokens(o.title);
  const titleFits = (e: Entry) => {
    const et = titleTokens(e.title);
    return et.size > 0 && [...et].every((w) => rt.has(w));
  };
  return (
    sameCode.find(titleFits) ??
    (sameCode.length === 1 ? sameCode[0] : undefined) ??
    free.find((e) => e.anzscoCode == null && titleFits(e))
  );
}

export type ReviewRow = {
  occupation: string;
  code: string;
  rubricId: string;
  rubricHeading: string;
  rubricTier: string;
  candidate: string;
  candidateId: string;
  candidateTier: string;
  similarity: number;
  variants: number;
  /** The old name/containment loader linked this pair, so leaving it unlinked drops these variants. */
  linkedBefore: boolean;
  action: string;
};

export type PairReport = {
  headingsGivenIds: number;
  rubricRows: number;
  subjectsRows: number;
  exact: number;
  wording: number;
  uncertain: ReviewRow[];
  rubricNoCounterpart: number;
  subjectsOnly: number;
  addedOccupations: string[];
  fixedEntries: string[];
};

export function pairFiles(
  rubrics: { occupations: Occ[] },
  entries: Entry[],
  uncertainMin = 0.5,
): PairReport {
  const rep: PairReport = {
    headingsGivenIds: 0,
    rubricRows: 0,
    subjectsRows: 0,
    exact: 0,
    wording: 0,
    uncertain: [],
    rubricNoCounterpart: 0,
    subjectsOnly: 0,
    addedOccupations: [],
    fixedEntries: [],
  };
  const countMissing = (rows: Array<{ id?: unknown }>) =>
    rows.filter((r) => !/^\d+-T/.test(String(r.id ?? ""))).length;

  for (const o of rubrics.occupations) {
    if (o.flow !== "academic_3_tier") continue;
    const code = String(o.anzsco);
    const before = rubricRows(o, false);
    rep.headingsGivenIds += countMissing(before.map((r) => r.row));
    const rows = rubricRows(o, true);
    rep.rubricRows += rows.length;

    let entry = findEntry(o, entries);
    if (!entry) {
      entry = buildEntry(o, rows);
      entries.push(entry);
      rep.addedOccupations.push(`${o.id} (${code})`);
    }
    if (entry.anzscoCode == null || String(entry.anzscoCode) !== code) {
      rep.fixedEntries.push(`${entry.title}: anzscoCode ${entry.anzscoCode ?? "null"} -> ${code}`);
      entry.anzscoCode = code;
    }
    if (entry.occupationId !== o.id) setAfter(entry, "occupationId", o.id, "title");

    const groupKeys = Object.keys(entry.groups ?? {});
    const subj: Array<{ row: SubjRow; tier: number; group: string }> = [];
    for (const g of groupKeys) {
      for (const row of entry.groups![g]!.subjects ?? []) {
        subj.push({ row, tier: groupTier(g, groupKeys), group: g });
      }
    }
    rep.subjectsRows += subj.length;
    rep.headingsGivenIds += countMissing(subj.map((s) => s.row));

    const rubricIds = new Set(rows.map((r) => r.id));
    const linked = new Set<string>();
    // 1) confident pairs: exact first, then wording-only
    for (const kind of ["exact", "wording"] as const) {
      for (const s of subj) {
        if (s.row.id && /^\d+-T/.test(s.row.id)) {
          for (const id of [s.row.id, ...(s.row.alsoIds ?? [])]) if (rubricIds.has(id)) linked.add(id);
          continue;
        }
        const hit = rows.find((r) => pairKind(r.name, s.row.name) === kind);
        if (!hit) continue;
        if (kind === "exact" || exactKey(hit.name) !== exactKey(s.row.name)) {
          setIdFirst(s.row, hit.id);
          linked.add(hit.id);
          rep[kind]++;
        }
      }
    }
    // 2) subjects-only headings get their own X ids
    const used = new Set(subj.map((s) => s.row.id).filter(Boolean) as string[]);
    const nextX = new Map<number, number>();
    for (const s of subj) {
      if (s.row.id && /^\d+-T/.test(s.row.id)) continue;
      let n = nextX.get(s.tier) ?? 1;
      let id = `${code}-T${s.tier}.X${n}`;
      while (used.has(id)) id = `${code}-T${s.tier}.X${++n}`;
      nextX.set(s.tier, n + 1);
      used.add(id);
      setIdFirst(s.row, id);
    }
    // 3) uncertain suggestions: unlinked rubric rows vs unlinked subjects rows
    const freeSubj = subj.filter((s) => !rubricIds.has(String(s.row.id)) && !/^others$/i.test(s.row.name.trim()));
    rep.subjectsOnly += subj.filter((s) => !rubricIds.has(String(s.row.id))).length;
    for (const r of rows) {
      if (linked.has(r.id)) continue;
      let best: { s: (typeof subj)[number]; sim: number } | null = null;
      for (const s of freeSubj) {
        const sim = similarity(r.name, s.row.name);
        if (!best || sim > best.sim) best = { s, sim };
      }
      if (!best || best.sim < uncertainMin) {
        rep.rubricNoCounterpart++;
        continue;
      }
      const sim = Math.round(best.sim * 100) / 100;
      rep.uncertain.push({
        occupation: o.id,
        code,
        rubricId: r.id,
        rubricHeading: r.name,
        rubricTier: r.tier,
        candidate: best.s.row.name,
        candidateId: String(best.s.row.id),
        candidateTier: `T${best.s.tier} (${best.s.group})`,
        similarity: sim,
        variants: best.s.row.variants?.length ?? 0,
        linkedBefore: legacyLooseMatch(r.name, best.s.row.name),
        action: legacyLooseMatch(r.name, best.s.row.name)
          ? "Was linked before Phase 2 (loose containment) - now unlinked; set the subjects-file id to the rubric id to restore"
          : sim >= 0.7
            ? "Likely the same subject - link (set the subjects-file id to the rubric id)"
            : "Check scope - link only if the subjects-file heading covers the same subject",
      });
    }
  }
  return rep;
}

/** New subjects-file entry built from rubric headings (heading name is the only variant). */
function buildEntry(o: Occ, rows: RubricRow[]): Entry {
  const pick = (pred: (r: RubricRow) => boolean) =>
    rows.filter(pred).map((r) => ({ id: r.id, name: r.name, variants: [r.name] }));
  const groups: Entry["groups"] = {};
  const add = (key: string, label: string, subjects: SubjRow[]) => {
    if (subjects.length) groups![key] = { categoryLabel: label, subjects };
  };
  add("tier1", "Foundational Subjects", pick((r) => r.tier.startsWith("T1")));
  add("tier2_core", "Core Subjects", pick((r) => r.tier === "T2 core"));
  add("tier2_optional", "Optional Subjects", pick((r) => r.tier === "T2 optional"));
  add("tier3_core", "Capstone Project, Practical Training Subjects", pick((r) => r.tier === "T3 gate" || r.tier === "T3 supporting"));
  add("tier3_optional", "Optional Practical Subjects", pick((r) => r.tier === "T3 optional"));
  return {
    anzscoCode: String(o.anzsco),
    title: o.title,
    occupationId: o.id,
    sourceSheet: "Generated from anzsco-verification-rubrics.json (no variant sheet yet)",
    groups,
  };
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function reviewCsv(rows: ReviewRow[]): string {
  const head = [
    "occupation", "code", "rubric_id", "rubric_heading", "rubric_tier",
    "subjects_file_candidate", "candidate_id", "candidate_tier", "similarity",
    "candidate_variants", "linked_before_phase2", "suggested_action",
  ];
  const lines = [head.join(",")];
  const sorted = [...rows].sort((a, b) => Number(b.linkedBefore) - Number(a.linkedBefore));
  for (const r of sorted) {
    lines.push([
      r.occupation, r.code, r.rubricId, r.rubricHeading, r.rubricTier,
      r.candidate, r.candidateId, r.candidateTier, r.similarity.toFixed(2),
      r.variants, r.linkedBefore ? "yes" : "no", r.action,
    ].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** Serialise like the source file: 2-space JSON, same line endings, same trailing newline. */
function writeLike(path: string, original: string, data: unknown) {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const trailing = /\r?\n$/.test(original);
  let text = JSON.stringify(data, null, 2);
  if (eol === "\r\n") text = text.replace(/\n/g, "\r\n");
  writeFileSync(path, text + (trailing ? eol : ""));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const write = process.argv.includes("--write");
  const csvIdx = process.argv.indexOf("--csv");
  const csvPath = csvIdx > 0 ? process.argv[csvIdx + 1] : resolve(here, "subject-id-review.csv");
  const rubricsText = readFileSync(RUBRICS, "utf8");
  const subjectsText = readFileSync(SUBJECTS, "utf8");
  const rubrics = JSON.parse(rubricsText);
  const entries = JSON.parse(subjectsText) as Entry[];
  const rep = pairFiles(rubrics, entries);
  console.log(JSON.stringify({ ...rep, uncertain: rep.uncertain.length }, null, 2));
  if (write) {
    writeLike(RUBRICS, rubricsText, rubrics);
    writeLike(SUBJECTS, subjectsText, entries);
    writeFileSync(csvPath!, reviewCsv(rep.uncertain));
    console.log(`wrote ids to both JSON files and ${rep.uncertain.length} uncertain pairs to ${csvPath}`);
  } else {
    console.log("dry run - pass --write to save");
  }
}
