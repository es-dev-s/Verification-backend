import { parseCompletionYear } from "../assess/qualificationYear.js";
import { combineResultCards, parseResultCard } from "../assess/resultCard.js";
import type { DocumentTypeLabel, PerSourceEducation } from "./schemas.js";

const YEAR_PRIORITY: DocumentTypeLabel[] = ["CERTIFICATE", "TRANSCRIPT", "CV"];

/**
 * Yearly marks cards that share a registration are one qualification.
 * Each source keeps the combined title (so 2015 / 2016 / 2017 is not a
 * conflict) and the latest examination year.
 */
export function alignResultCardSources(
  sources: PerSourceEducation[],
  texts: ReadonlyMap<string, string>,
): PerSourceEducation[] {
  const parsed = sources.map((source) => ({
    source,
    card: parseResultCard(texts.get(source.documentId) ?? ""),
  }));
  const combined = combineResultCards(
    parsed.map((row) => row.card).filter((card) => card != null),
  );
  if (!combined) return sources;
  return parsed.map(({ source, card }) => {
    if (!card || card.registrationNumber !== combined.registrationNumber) return source;
    return {
      ...source,
      extract: {
        ...source.extract,
        degreeTitle: combined.title,
        end:
          combined.completionYear != null
            ? String(combined.completionYear)
            : source.extract.end,
        statedDuration:
          combined.years > 0 ? `${combined.years} years` : source.extract.statedDuration,
      },
    };
  });
}

/**
 * Completion year for the qualification. Certificates beat transcripts beat
 * the CV, and yearly cards of that type use the latest examination year.
 */
export function completionYearFromSources(
  sources: readonly { documentType: string; end: string | null | undefined }[],
): number | null {
  const withYear = sources
    .map((source) => ({
      type: source.documentType,
      year: parseCompletionYear(source.end ?? null),
    }))
    .filter((source): source is { type: string; year: number } => source.year != null);
  if (!withYear.length) return null;
  const rank = (type: string) => {
    const index = YEAR_PRIORITY.indexOf(type as DocumentTypeLabel);
    return index === -1 ? 99 : index;
  };
  const best = Math.min(...withYear.map((source) => rank(source.type)));
  return Math.max(...withYear.filter((source) => rank(source.type) === best).map((source) => source.year));
}
