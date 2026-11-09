import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adjustByFamily,
  etFormulaConfidence,
  familyAdjustmentForResult,
  matchedBackfill,
  matchedSlotsMissing,
  pickPrimary,
} from "./familyAdjust.js";
import type { AnzscoCandidate } from "./schemas.js";

const occ = (anzscoCode: string, title: string, confidence: number) => ({
  anzscoCode,
  title,
  confidence,
});
const byCode = (r: ReturnType<typeof adjustByFamily>, code: string) =>
  r.occupations.find((o) => o.anzscoCode === code)!;

describe("family adjustment", () => {
  it("ET formula: gap shrinks from 10 at 50% to 5 at 100%", () => {
    assert.equal(etFormulaConfidence(50), 40);
    assert.equal(etFormulaConfidence(75), 67.5);
    assert.equal(etFormulaConfidence(82), 75.2);
    assert.equal(etFormulaConfidence(100), 95);
  });

  it("example 1: Civil 75 primary, Mechanical 65 -> 45, ET 67.5", () => {
    const r = adjustByFamily(occ("233211", "Civil Engineer", 75), [
      occ("233512", "Mechanical Engineer", 65),
    ]);
    const mech = byCode(r, "233512");
    assert.equal(mech.adjustedConfidence, 45);
    assert.equal(mech.reason, "Different family −20 pp");
    assert.ok(mech.changed);
    assert.equal(r.maybeSuitable?.adjustedConfidence, 67.5);
    assert.equal(r.maybeSuitable?.label, "Maybe Suitable");
    assert.equal(r.maybeSuitable?.source, "formula");
    assert.equal(r.occupations[0]!.isPrimary, true);
  });

  it("example 2: Electrical 82 primary with same, different and overlapping families", () => {
    const r = adjustByFamily(occ("233311", "Electrical Engineer", 82), [
      occ("233411", "Electronics Engineer", 70),
      occ("233211", "Civil Engineer", 60),
      occ("233913", "Biomedical Engineer", 50),
    ]);
    assert.equal(byCode(r, "233411").adjustedConfidence, 70);
    assert.equal(byCode(r, "233411").reason, "Same family (ECE)");
    assert.equal(byCode(r, "233211").adjustedConfidence, 40);
    assert.equal(byCode(r, "233913").adjustedConfidence, 50);
    assert.equal(byCode(r, "233913").reason, "Overlapping family (ECE)");
    assert.equal(r.maybeSuitable?.adjustedConfidence, 75.2);
    // Alternatives re-sorted by adjusted confidence.
    assert.deepEqual(
      r.occupations.slice(1).map((o) => o.anzscoCode),
      ["233411", "233913", "233211"],
    );
  });

  it("example 3: Mining 48 primary -> no ET, Mechanical −20", () => {
    const r = adjustByFamily(occ("233611", "Mining Engineer", 48), [
      occ("233111", "Chemical Engineer", 44),
      occ("233915", "Environmental Engineer", 42),
      occ("233512", "Mechanical Engineer", 40),
    ]);
    assert.equal(byCode(r, "233111").adjustedConfidence, 44);
    assert.equal(byCode(r, "233915").adjustedConfidence, 42);
    assert.equal(byCode(r, "233512").adjustedConfidence, 20);
    assert.equal(r.maybeSuitable, null);
  });

  it("no ET at exactly 50", () => {
    const r = adjustByFamily(occ("233211", "Civil Engineer", 50), []);
    assert.equal(r.maybeSuitable, null);
  });

  it("ET uses the higher of its own score and the formula", () => {
    const r = adjustByFamily(occ("233311", "Electrical Engineer", 82), [], {
      etOwnConfidence: 80,
    });
    assert.equal(r.maybeSuitable?.adjustedConfidence, 80);
    assert.equal(r.maybeSuitable?.source, "own_score");
    assert.equal(r.maybeSuitable?.originalConfidence, 80);
  });

  it("ET own score above the primary is capped one point below", () => {
    const r = adjustByFamily(occ("233311", "Electrical Engineer", 82), [
      occ("233914", "Engineering Technologist", 85),
    ]);
    assert.equal(r.maybeSuitable?.adjustedConfidence, 81);
    assert.equal(r.maybeSuitable?.capped, true);
    assert.equal(r.maybeSuitable?.inCandidates, true);
    // Shown once, as the Maybe Suitable card.
    assert.equal(r.occupations.some((o) => o.anzscoCode === "233914"), false);
  });

  it("level-2 primary gets no ET; a suggested ET stays a normal alternative", () => {
    const r = adjustByFamily(occ("312311", "Electrical Engineering Draftsperson", 70), [
      occ("233914", "Engineering Technologist", 60),
    ]);
    assert.equal(r.maybeSuitable, null);
    assert.equal(byCode(r, "233914").adjustedConfidence, 60);
    assert.equal(byCode(r, "233914").reason, "Overlapping family (ECE)");
  });

  it("alternative equal to the primary is capped below it", () => {
    const r = adjustByFamily(occ("233311", "Electrical Engineer", 70), [
      occ("233411", "Electronics Engineer", 70),
    ]);
    assert.equal(byCode(r, "233411").adjustedConfidence, 69);
    assert.equal(byCode(r, "233411").capped, true);
  });

  it("penalty clamps at zero; unknown codes stay unchanged with a note", () => {
    const r = adjustByFamily(occ("233211", "Civil Engineer", 60), [
      occ("233512", "Mechanical Engineer", 12),
      occ("999999", "Unknown", 30),
    ]);
    assert.equal(byCode(r, "233512").adjustedConfidence, 0);
    assert.equal(byCode(r, "999999").adjustedConfidence, 30);
    assert.equal(r.notes.length, 1);
  });

  it("primary = highest recommended candidate; assessor pick wins", () => {
    const c = (code: string, score: number, recommended: boolean) =>
      ({ anzscoCode: code, title: code, confidenceScore: score, recommended }) as AnzscoCandidate;
    const list = [c("233211", 60, true), c("233512", 70, true), c("233311", 90, false)];
    assert.equal(pickPrimary(list)?.anzscoCode, "233512");
    assert.equal(pickPrimary(list, "233211")?.anzscoCode, "233211");
    const r = familyAdjustmentForResult({ candidates: list });
    assert.equal(r?.primaryCode, "233512");
    // Non-recommended Electrical (90, different family) -> 70 -> capped at 69.
    const elec = r!.occupations.find((o) => o.anzscoCode === "233311")!;
    assert.equal(elec.adjustedConfidence, 69);
  });

  describe("matched slots when ET moves to Maybe Suitable", () => {
    const c = (code: string, score: number, recommended = true) =>
      ({ anzscoCode: code, title: code, confidenceScore: score, recommended }) as AnzscoCandidate;
    const view = (x: AnzscoCandidate) => x;

    it("ET in the top 3 and qualifying: 3 matched cards plus ET", () => {
      // Chemical 72 primary; ET 70 took the 3rd slot.
      const top = [c("233111", 72), c("233914", 70), c("233112", 66)];
      const ranked = [...top, c("233513", 60), c("233211", 55)];
      assert.equal(matchedSlotsMissing(top, 3), 1);
      const fills = matchedBackfill(top, ranked, 3, view);
      assert.deepEqual(fills.map((f) => f.anzscoCode), ["233513"]);
      const r = familyAdjustmentForResult({ candidates: [...top, ...fills] })!;
      assert.equal(r.primaryCode, "233111");
      const alts = r.occupations.filter((o) => !o.isPrimary).map((o) => o.anzscoCode);
      assert.equal(alts.length, 2);
      assert.ok(!alts.includes("233914"));
      assert.equal(r.maybeSuitable?.anzscoCode, "233914");
      assert.equal(r.maybeSuitable?.inCandidates, true);
    });

    it("no backfill when ET does not qualify or is not in the top 3", () => {
      // Level 2 primary: ET stays a normal alternative.
      assert.equal(matchedSlotsMissing([c("312311", 70), c("233914", 60), c("233211", 50)], 3), 0);
      // Primary at exactly 50: ET not offered.
      assert.equal(matchedSlotsMissing([c("233111", 50), c("233914", 45), c("233112", 40)], 3), 0);
      // ET outside the top 3: already 3 matched.
      assert.equal(matchedSlotsMissing([c("233111", 80), c("233112", 70), c("233513", 60)], 3), 0);
    });

    it("fewer scored occupations: shows what exists, skips ET and duplicates", () => {
      const top = [c("233111", 72), c("233914", 70)];
      assert.equal(matchedSlotsMissing(top, 3), 2);
      const fills = matchedBackfill(top, [...top, c("233112", 50), c("233112", 50)], 3, view);
      assert.deepEqual(fills.map((f) => f.anzscoCode), ["233112"]);
    });
  });
});
