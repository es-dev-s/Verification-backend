/**
 * Per-source results of the Phase 1 transcript / certificate read, after the
 * Groq call (or its failure). Pure: no DB, no network, so it is unit-tested.
 */
import { fillEmptyEducationFields } from "./degreeReaderText.js";
import { heuristicsEducationMulti, heuristicsPerSource } from "./heuristics.js";
import { checkLevelMismatch, type LevelMismatch } from "./levelMismatch.js";
import { sanitizeEducationExtract } from "./sanitizeExtracted.js";
import {
  educationExtractSchema,
  educationMultiExtractSchema,
  type DegreeLevelLabel,
  type DocumentTypeLabel,
  type EducationExtract,
  type PerSourceEducation,
} from "./schemas.js";

export type LabeledLevelDoc = {
  documentId: string;
  documentType: DocumentTypeLabel;
  text: string;
};

const emptyExtract = (): EducationExtract => ({
  degreeTitle: null,
  institution: null,
  country: null,
  start: null,
  end: null,
  statedDuration: null,
  multipleBachelors: false,
});

/**
 * Turn the Groq output into one extract per document.
 * fallback is true only when Groq failed (groqFailed) or every field came back
 * empty. A level mismatch is reported separately and never sets fallback.
 */
export function resolveLevelSources(input: {
  labeled: LabeledLevelDoc[];
  data: Record<string, unknown>;
  degreeLevel: DegreeLevelLabel;
  groqFailed: boolean;
}): {
  sources: PerSourceEducation[];
  data: Record<string, unknown>;
  fallback: boolean;
  levelMismatches: LevelMismatch[];
  emptyFields: boolean;
} {
  const { labeled, degreeLevel } = input;
  let data = input.data;
  let fallback = input.groqFailed;

  const multi = educationMultiExtractSchema.safeParse(data);
  const byId = new Map(
    (multi.success ? multi.data.sources : []).map((s) => [s.documentId, s]),
  );

  let sources: PerSourceEducation[] = labeled.map((d) => {
    const raw = byId.get(d.documentId);
    const parsed = raw ? educationExtractSchema.safeParse(raw) : null;
    const extract = parsed?.success ? parsed.data : emptyExtract();
    return {
      documentId: d.documentId,
      documentType: d.documentType,
      extract: fillEmptyEducationFields(sanitizeEducationExtract(extract), d.text),
      degreeLevel,
    };
  });

  const anyValue = sources.some((s) =>
    Boolean(
      s.extract.degreeTitle ||
        s.extract.institution ||
        s.extract.country ||
        s.extract.start ||
        s.extract.end,
    ),
  );
  if (!anyValue) {
    sources = heuristicsPerSource(labeled).map((s) => ({
      ...s,
      extract: sanitizeEducationExtract(s.extract),
      degreeLevel,
    }));
    data = heuristicsEducationMulti(labeled) as unknown as Record<string, unknown>;
    fallback = true;
  }

  const textById = new Map(labeled.map((d) => [d.documentId, d.text]));
  const levelMismatches: LevelMismatch[] = [];
  sources = sources.map((s) => {
    const checked = checkLevelMismatch({
      documentId: s.documentId,
      documentType: s.documentType,
      targetLevel: degreeLevel,
      text: textById.get(s.documentId) ?? "",
      extract: s.extract,
    });
    if (checked.mismatch) levelMismatches.push(checked.mismatch);
    return { ...s, extract: checked.extract };
  });

  return { sources, data, fallback, levelMismatches, emptyFields: !anyValue };
}
