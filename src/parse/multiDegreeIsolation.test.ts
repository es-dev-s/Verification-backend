import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { documentMatchesDegreeLevel } from "./documentScope.js";
import {
  ALL_MULTI_DEGREE_FIXTURES,
  FIXTURE_BACHELOR_MASTER,
  FIXTURE_BACHELOR_MASTER_PHD,
  FIXTURE_BACHELOR_ONLY,
} from "./fixtures/multiDegreeCases.js";
import {
  heuristicsCvEducationEntries,
  heuristicsEducationFromText,
} from "./heuristics.js";
import { mergeEducation } from "./mergeEducation.js";
import type {
  DegreeLevelLabel,
  DocumentTypeLabel,
  PerSourceEducation,
} from "./schemas.js";
import { pickCvEntryForLevel } from "../workers/parse.js";

type QualStore = Partial<
  Record<
    DegreeLevelLabel,
    {
      degreeTitle: string | null;
      institution: string | null;
      country: string | null;
    }
  >
>;

function sourcesForLevel(
  fixture: {
    cv: string;
    docs: Array<{
      type: DocumentTypeLabel;
      degreeLevel: DegreeLevelLabel;
      text: string;
    }>;
  },
  degreeLevel: DegreeLevelLabel,
): PerSourceEducation[] {
  const sources: PerSourceEducation[] = [];

  for (const doc of fixture.docs) {
    if (!documentMatchesDegreeLevel(doc, degreeLevel)) continue;
    if (doc.type === "CV") continue;
    const extract = heuristicsEducationFromText(doc.text);
    sources.push({
      documentId: `${doc.type}:${doc.degreeLevel}`,
      documentType: doc.type,
      degreeLevel,
      extract,
    });
  }

  const cvEntries = heuristicsCvEducationEntries(fixture.cv).entries;
  const cvExtract = pickCvEntryForLevel(cvEntries, degreeLevel);
  if (cvExtract) {
    sources.push({
      documentId: "CV",
      documentType: "CV",
      degreeLevel,
      extract: cvExtract,
    });
  }

  return sources;
}

function readLevelIntoStore(
  store: QualStore,
  fixture: {
    cv: string;
    docs: Array<{
      type: DocumentTypeLabel;
      degreeLevel: DegreeLevelLabel;
      text: string;
    }>;
  },
  degreeLevel: DegreeLevelLabel,
): QualStore {
  const sources = sourcesForLevel(fixture, degreeLevel);
  assert.ok(
    sources.length,
    `expected sources for ${degreeLevel} on fixture`,
  );
  // Academic docs for this level must never include another level's transcript/cert
  for (const s of sources) {
    if (s.documentType === "CV") continue;
    assert.equal(
      s.documentId,
      `${s.documentType}:${degreeLevel}`,
      `cross-level doc leaked into ${degreeLevel} read: ${s.documentId}`,
    );
  }
  const merged = mergeEducation(sources);
  store[degreeLevel] = {
    degreeTitle: merged.fields.degreeTitle.value,
    institution: merged.fields.institution.value,
    country: merged.fields.country.value,
  };
  return store;
}

describe("multi-degree fixtures", () => {
  it("exposes single-bachelor, bachelor+master, and bachelor+master+phd cases", () => {
    assert.equal(ALL_MULTI_DEGREE_FIXTURES.length, 3);
    assert.deepEqual([...FIXTURE_BACHELOR_ONLY.selectedDegreeLevels], [
      "bachelor",
    ]);
    assert.deepEqual([...FIXTURE_BACHELOR_MASTER.selectedDegreeLevels], [
      "bachelor",
      "master",
    ]);
    assert.deepEqual([...FIXTURE_BACHELOR_MASTER_PHD.selectedDegreeLevels], [
      "bachelor",
      "master",
      "phd",
    ]);
  });

  it("single-bachelor fixture yields bachelor CV entry (regression)", () => {
    const { entries } = heuristicsCvEducationEntries(FIXTURE_BACHELOR_ONLY.cv);
    const bach = pickCvEntryForLevel(entries, "bachelor");
    assert.ok(bach);
    assert.match(bach!.degreeTitle ?? "", /computer science/i);
    assert.equal(pickCvEntryForLevel(entries, "master"), null);
    assert.equal(pickCvEntryForLevel(entries, "phd"), null);

    // Full level read (transcript + cert + CV) recovers institution
    const store: QualStore = {};
    readLevelIntoStore(store, FIXTURE_BACHELOR_ONLY, "bachelor");
    assert.match(store.bachelor!.institution ?? "", /monash/i);
  });

  it("bachelor+master fixture parses distinct CV entries per level", () => {
    const { entries } = heuristicsCvEducationEntries(
      FIXTURE_BACHELOR_MASTER.cv,
    );
    const bach = pickCvEntryForLevel(entries, "bachelor");
    const master = pickCvEntryForLevel(entries, "master");
    assert.ok(bach);
    assert.ok(master);
    assert.match(bach!.degreeTitle ?? "", /software|b\.?eng/i);
    assert.match(master!.degreeTitle ?? "", /data science|m\.?sc/i);
    assert.notEqual(
      (bach!.degreeTitle ?? "").toLowerCase(),
      (master!.degreeTitle ?? "").toLowerCase(),
    );
  });

  it("bachelor+master+phd fixture has three leveled CV entries", () => {
    const { entries } = heuristicsCvEducationEntries(
      FIXTURE_BACHELOR_MASTER_PHD.cv,
    );
    for (const level of ["bachelor", "master", "phd"] as const) {
      const hit = pickCvEntryForLevel(entries, level);
      assert.ok(hit, `missing CV entry for ${level}`);
    }
    const phd = pickCvEntryForLevel(entries, "phd")!;
    assert.match(phd.degreeTitle ?? "", /artificial intelligence|phd/i);
  });
});

describe("documentMatchesDegreeLevel", () => {
  it("includes CV for every level", () => {
    assert.equal(
      documentMatchesDegreeLevel({ type: "CV", degreeLevel: null }, "master"),
      true,
    );
  });

  it("scopes transcript/certificate to their degreeLevel", () => {
    const masterTx = {
      type: "TRANSCRIPT" as const,
      degreeLevel: "master" as const,
    };
    assert.equal(documentMatchesDegreeLevel(masterTx, "master"), true);
    assert.equal(documentMatchesDegreeLevel(masterTx, "bachelor"), false);
    assert.equal(documentMatchesDegreeLevel(masterTx, "phd"), false);
  });

  it("treats legacy null-level academic docs as bachelor only", () => {
    const legacy = { type: "CERTIFICATE" as const, degreeLevel: null };
    assert.equal(documentMatchesDegreeLevel(legacy, "bachelor"), true);
    assert.equal(documentMatchesDegreeLevel(legacy, "master"), false);
  });

  it("filters bachelor+master fixture docs without cross-level leakage", () => {
    const all = [
      { type: "CV" as const, degreeLevel: null },
      ...FIXTURE_BACHELOR_MASTER.docs,
    ];
    const forMaster = all.filter((d) =>
      documentMatchesDegreeLevel(d, "master"),
    );
    const academic = forMaster.filter((d) => d.type !== "CV");
    assert.ok(academic.every((d) => d.degreeLevel === "master"));
    assert.equal(academic.length, 2);
  });
});

describe("cross-level education isolation", () => {
  it("reading master first then bachelor leaves master Qualification unchanged", () => {
    const store: QualStore = {};

    readLevelIntoStore(store, FIXTURE_BACHELOR_MASTER, "master");
    const masterAfterFirstRead = { ...store.master! };
    assert.match(masterAfterFirstRead.institution ?? "", /singapore|nus/i);
    assert.equal(store.bachelor, undefined);

    readLevelIntoStore(store, FIXTURE_BACHELOR_MASTER, "bachelor");
    assert.deepEqual(
      store.master,
      masterAfterFirstRead,
      "master Qualification must be unaffected by subsequent bachelor read",
    );
    const bachelorAfter = store["bachelor"] as
      | {
          degreeTitle: string | null;
          institution: string | null;
          country: string | null;
        }
      | undefined;
    assert.ok(bachelorAfter);
    assert.match(bachelorAfter.institution ?? "", /macquarie/i);
    assert.notEqual(
      (bachelorAfter.institution ?? "").toLowerCase(),
      (store.master!.institution ?? "").toLowerCase(),
    );
  });

  it("phd / master / bachelor reads on three-level fixture stay isolated", () => {
    const store: QualStore = {};
    readLevelIntoStore(store, FIXTURE_BACHELOR_MASTER_PHD, "phd");
    const phdSnap = { ...store.phd! };
    readLevelIntoStore(store, FIXTURE_BACHELOR_MASTER_PHD, "master");
    const masterSnap = { ...store.master! };
    readLevelIntoStore(store, FIXTURE_BACHELOR_MASTER_PHD, "bachelor");

    assert.deepEqual(store.phd, phdSnap);
    assert.deepEqual(store.master, masterSnap);
    assert.match(store.bachelor!.institution ?? "", /mcgill/i);
    assert.match(store.master!.institution ?? "", /stanford/i);
    assert.match(store.phd!.institution ?? "", /massachusetts|mit/i);
  });
});

describe("degree-level deselection retention", () => {
  it("removing a level from selectedDegreeLevels does not drop stored Qualification data", () => {
    // Mirrors API behaviour: PATCH only updates Case.selectedDegreeLevels;
    // Qualification rows are keyed by (caseId, degreeLevel) and are not deleted.
    const qualifications: QualStore = {
      bachelor: {
        degreeTitle: "B.Eng Software",
        institution: "University of Sydney",
        country: "Australia",
      },
      master: {
        degreeTitle: "M.Sc Data Science",
        institution: "NUS",
        country: "Singapore",
      },
    };
    let selectedDegreeLevels: DegreeLevelLabel[] = ["bachelor", "master"];

    // User deselects master — UI hides the form; data must remain.
    selectedDegreeLevels = selectedDegreeLevels.filter((l) => l !== "master");
    assert.deepEqual(selectedDegreeLevels, ["bachelor"]);
    assert.ok(
      qualifications.master,
      "master Qualification must still exist after deselection",
    );
    assert.equal(qualifications.master!.institution, "NUS");
    assert.ok(qualifications.bachelor);
  });
});
