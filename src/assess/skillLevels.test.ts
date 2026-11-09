import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ENGINEERING_TECHNOLOGIST_CODE, etQualifiesForPrimary, familyOf } from "./familyAdjust.js";
import { trackForAnzsco } from "./gate1.js";

/**
 * anzsco_families.json (family rules, level-1 ET rule) and
 * anzsco_skill_levels.json (Gate 1 tracks) both carry skill levels.
 * anzsco_families.json is the final list; the two files must agree.
 */
const here = dirname(fileURLToPath(import.meta.url));
const readJson = <T>(name: string) => JSON.parse(readFileSync(resolve(here, "../lib", name), "utf8")) as T;

type Fam = { families: Array<{ id: string; levelsPresent: string[]; anzscoCodes: string[] }>; occupations: Array<{ anzscoCode: string; skillLevel: number; families: string[] }> };
type Lev = { categories: Array<{ category: string; skillLevel: number }>; occupations: Array<{ anzscoCode: string; category: string; skillLevel: number }> };

const fam = readJson<Fam>("anzsco_families.json");
const lev = readJson<Lev>("anzsco_skill_levels.json");

describe("ANZSCO skill levels: families file and skill-levels file agree", () => {
  it("every occupation is in both files with the same skill level", () => {
    const famBy = new Map(fam.occupations.map((o) => [o.anzscoCode, o.skillLevel]));
    const levBy = new Map(lev.occupations.map((o) => [o.anzscoCode, o.skillLevel]));
    for (const [code, level] of famBy) assert.equal(levBy.get(code), level, `${code} in anzsco_skill_levels.json`);
    for (const [code, level] of levBy) assert.equal(famBy.get(code), level, `${code} in anzsco_families.json`);
    assert.equal(famBy.size, fam.occupations.length, "duplicate code in anzsco_families.json occupations");
    assert.equal(levBy.size, lev.occupations.length, "duplicate code in anzsco_skill_levels.json");
  });

  it("each category's level matches its occupations; only 233914 is Engineering Technologist", () => {
    const catLevel = new Map(lev.categories.map((c) => [c.category, c.skillLevel]));
    for (const o of lev.occupations) {
      assert.equal(catLevel.get(o.category), o.skillLevel, `${o.anzscoCode} category ${o.category}`);
      assert.equal(o.category === "Engineering Technologist", o.anzscoCode === ENGINEERING_TECHNOLOGIST_CODE, o.anzscoCode);
    }
  });

  it("family code lists match each occupation's families", () => {
    for (const f of fam.families) {
      for (const code of f.anzscoCodes) {
        assert.ok(familyOf(code)?.families.includes(f.id), `${code} lists ${f.id}`);
      }
    }
    for (const o of fam.occupations) {
      for (const id of o.families) {
        assert.ok(fam.families.find((f) => f.id === id)?.anzscoCodes.includes(o.anzscoCode), `${id} has ${o.anzscoCode}`);
      }
    }
  });

  it("final levels: 313212 is L2 (Associate, no ET); 133211 and 233999 are L1", () => {
    assert.equal(familyOf("313212")?.skillLevel, 2);
    assert.equal(trackForAnzsco("313212"), "engineering_associate");
    assert.equal(etQualifiesForPrimary("313212", 90), false);
    assert.equal(familyOf("133211")?.skillLevel, 1);
    assert.equal(trackForAnzsco("133211"), "professional_engineer");
    assert.equal(familyOf("233999")?.skillLevel, 1);
    assert.equal(etQualifiesForPrimary("233999", 60), true);
  });
});
