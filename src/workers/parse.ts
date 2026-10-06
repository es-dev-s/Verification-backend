import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { acquireParseSlot } from "../lib/rateLimit.js";
import { computeDuration } from "../parse/duration.js";
import {
  generateJsonGroqSplit,
  mergeCvEducationParts,
  mergeEducationMultiParts,
  mergeExperienceParts,
} from "../parse/groqFormParse.js";
import {
  heuristicsCvEducationEntries,
  heuristicsEducationMulti,
  heuristicsExperienceFromText,
  heuristicsPerSource,
} from "../parse/heuristics.js";
import { mergeEducation } from "../parse/mergeEducation.js";
import {
  cvEducationSystemPrompt,
  educationMultiSystemPrompt,
  experienceSystemPrompt,
} from "../parse/prompts.js";
import {
  cvEducationExtractSchema,
  educationExtractSchema,
  educationMultiExtractSchema,
  experienceExtractSchema,
  type CvEducationEntry,
  type DegreeLevelLabel,
  type DocumentTypeLabel,
  type EducationExtract,
  type PerSourceEducation,
} from "../parse/schemas.js";
import { correctOcrEducationText } from "../parse/ocrCorrect.js";
import {
  sanitizeEducationExtract,
  sanitizeExtractedLabel,
} from "../parse/sanitizeExtracted.js";

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
 * Parse every education entry on a CV, each tagged with a degreeLevel guess.
 * Does not filter by case.selectedDegreeLevels — callers do that.
 */
export async function parseCvEducationEntries(
  cvText: string,
): Promise<{ entries: CvEducationEntry[]; fallback: boolean; geminiRaw: unknown }> {
  const cleaned = correctOcrEducationText(cvText.slice(0, 20_000), "cv").text;
  let data: unknown;
  let fallback = false;

  try {
    await acquireParseSlot(config.parseRpm);
    const out = await generateJsonGroqSplit({
      bodyText: cleaned,
      header: "--- CV text ---",
      systemPrompt: cvEducationSystemPrompt(),
      responseSchema: cvEducationExtractSchema,
      mergeParts: mergeCvEducationParts,
      maxTokens: 3072,
    });
    data = out.data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[parse/cv-education] Groq failed (${message}) — heuristics fallback`,
    );
    data = heuristicsCvEducationEntries(cleaned);
    fallback = true;
  }

  let parsed = cvEducationExtractSchema.safeParse(data);
  if (!parsed.success || !parsed.data.entries.length) {
    if (!fallback) {
      console.warn(
        "[parse/cv-education] empty/invalid Groq entries — heuristics fallback",
      );
    }
    data = heuristicsCvEducationEntries(cleaned);
    parsed = cvEducationExtractSchema.safeParse(data);
    fallback = true;
  }

  const entries = (parsed.success ? parsed.data.entries : []).map((e) => ({
    ...sanitizeEducationExtract(e),
    degreeLevel: e.degreeLevel,
  }));

  return { entries, fallback, geminiRaw: data };
}

/** Filter CV multi-entries down to one degree level (first match). */
export function pickCvEntryForLevel(
  entries: CvEducationEntry[],
  degreeLevel: DegreeLevelLabel,
): EducationExtract | null {
  const hit = entries.find((e) => e.degreeLevel === degreeLevel);
  if (!hit) return null;
  const { degreeLevel: _level, ...rest } = hit;
  return rest;
}

export async function parseEducation(
  caseId: string,
  degreeLevel: DegreeLevelLabel = "bachelor",
) {
  const caseRow = await prisma.case.findUnique({
    where: { id: caseId },
    select: { selectedDegreeLevels: true },
  });
  if (
    caseRow?.selectedDegreeLevels?.length &&
    !caseRow.selectedDegreeLevels.includes(degreeLevel)
  ) {
    return {
      qualification: null,
      bachelors: null,
      degreeLevel,
      fields: {},
      fromCvOnly: false,
      flags: ["level_not_selected"],
      message: `Degree level "${degreeLevel}" is not in selectedDegreeLevels`,
      geminiRaw: null,
      fallback: false,
    };
  }

  const docs = await prisma.document.findMany({
    where: {
      caseId,
      status: "DONE",
      text: { not: null },
      OR: [
        { type: "CV" },
        {
          type: { in: ["TRANSCRIPT", "CERTIFICATE"] },
          degreeLevel,
        },
        // Legacy single-degree docs stored without degreeLevel → treat as bachelor
        ...(degreeLevel === "bachelor"
          ? [
              {
                type: {
                  in: ["TRANSCRIPT", "CERTIFICATE"] as Array<
                    "TRANSCRIPT" | "CERTIFICATE"
                  >,
                },
                degreeLevel: null,
              },
            ]
          : []),
      ],
    },
  });

  const cvDoc = docs.find((d) => d.type === "CV");
  const levelDocs = docs.filter((d) => d.type !== "CV");

  if (!cvDoc && !levelDocs.length) {
    return {
      qualification: null,
      bachelors: null,
      degreeLevel,
      fields: {},
      fromCvOnly: false,
      flags: ["no_documents"],
      message: "No extracted documents to read for this degree level",
      geminiRaw: null,
      fallback: false,
    };
  }

  const labeled = levelDocs
    .map((doc) => {
      const raw = (doc.text ?? "").trim();
      if (!raw) return null;
      const { text } = correctOcrEducationText(raw, doc.id);
      return {
        documentId: doc.id,
        documentType: doc.type as DocumentTypeLabel,
        text: text.slice(0, 8_000),
      };
    })
    .filter((d): d is NonNullable<typeof d> => d != null);

  let sources: PerSourceEducation[] = [];
  let data: Record<string, unknown> = { sources: [] };
  let fallback = false;
  let geminiMeta: { keyUsed?: string; modelUsed?: string } = {};
  let cvGeminiRaw: unknown = null;

  // Transcript / certificate for this level — Groq split across keys
  if (labeled.length) {
    await acquireParseSlot(config.parseRpm);
    const bodyText = labeled
      .map(
        (d) =>
          `=== SOURCE documentId=${d.documentId} documentType=${d.documentType} ===\n${d.text}`,
      )
      .join("\n\n");
    const header = `Target degreeLevel=${degreeLevel}. Extract only fields for this level.`;

    try {
      const out = await generateJsonGroqSplit({
        bodyText,
        header,
        systemPrompt: educationMultiSystemPrompt(),
        responseSchema: educationMultiExtractSchema,
        mergeParts: mergeEducationMultiParts,
        maxTokens: 2048,
      });
      data = out.data;
      geminiMeta = { keyUsed: out.keyUsed, modelUsed: out.modelUsed };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[parse/education/${degreeLevel}] Groq failed (${message}) — heuristics fallback`,
      );
      data = heuristicsEducationMulti(labeled) as unknown as Record<
        string,
        unknown
      >;
      fallback = true;
    }

    const multi = educationMultiExtractSchema.safeParse(data);
    const byId = new Map(
      (multi.success ? multi.data.sources : []).map((s) => [s.documentId, s]),
    );

    sources = labeled.map((d) => {
      const raw = byId.get(d.documentId);
      if (!raw) {
        return {
          documentId: d.documentId,
          documentType: d.documentType,
          extract: emptyExtract(),
          degreeLevel,
        };
      }
      const parsed = educationExtractSchema.safeParse(raw);
      const extract = parsed.success ? parsed.data : emptyExtract();
      return {
        documentId: d.documentId,
        documentType: d.documentType,
        extract: sanitizeEducationExtract(extract),
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
      console.warn(
        `[parse/education/${degreeLevel}] empty Groq fields — heuristics fallback`,
      );
      sources = heuristicsPerSource(labeled).map((s) => ({
        ...s,
        extract: sanitizeEducationExtract(s.extract),
        degreeLevel,
      }));
      data = heuristicsEducationMulti(labeled) as unknown as Record<
        string,
        unknown
      >;
      fallback = true;
    }
  }

  // CV contribution: multi-entry parse, keep only this degreeLevel
  if (cvDoc?.text?.trim()) {
    const cvParsed = await parseCvEducationEntries(cvDoc.text);
    cvGeminiRaw = cvParsed.geminiRaw;
    if (cvParsed.fallback) fallback = true;
    const cvExtract = pickCvEntryForLevel(cvParsed.entries, degreeLevel);
    if (cvExtract) {
      sources.push({
        documentId: cvDoc.id,
        documentType: "CV",
        extract: sanitizeEducationExtract(cvExtract),
        degreeLevel,
      });
    }
  }

  if (!sources.length) {
    return {
      qualification: null,
      bachelors: null,
      degreeLevel,
      fields: {},
      fromCvOnly: false,
      flags: ["no_text"],
      message: `No usable education text for ${degreeLevel}`,
      geminiRaw: { levelDocs: data, cv: cvGeminiRaw },
      fallback,
    };
  }

  const merged = mergeEducation(sources);
  const durationYears =
    merged.fields.durationYears.value != null
      ? Number(merged.fields.durationYears.value)
      : null;

  const qualificationData = {
    degreeTitle: merged.fields.degreeTitle.value,
    institution: merged.fields.institution.value,
    country: merged.fields.country.value,
    durationYears: Number.isFinite(durationYears as number)
      ? (durationYears as number)
      : null,
    durationCalculated: merged.durationCalculated,
  };

  await prisma.qualification.upsert({
    where: { caseId_degreeLevel: { caseId, degreeLevel } },
    create: {
      caseId,
      degreeLevel,
      ...qualificationData,
    },
    update: qualificationData,
  });

  const fieldEntries = Object.entries(merged.fields) as Array<
    [keyof typeof merged.fields, (typeof merged.fields)[keyof typeof merged.fields]]
  >;

  for (const [field, meta] of fieldEntries) {
    await prisma.fieldSource.upsert({
      where: {
        caseId_field_degreeLevel: {
          caseId,
          field,
          degreeLevel,
        },
      },
      create: {
        caseId,
        field,
        degreeLevel,
        sourceDocumentId: meta.sourceDocumentId,
        extractedValue: meta.value,
        finalValue: meta.value,
        confidence: meta.confidence,
        alternatives: meta.alternatives,
      },
      update: {
        sourceDocumentId: meta.sourceDocumentId,
        extractedValue: meta.value,
        finalValue: meta.value,
        confidence: meta.confidence,
        alternatives: meta.alternatives,
      },
    });
  }

  const block = {
    ...qualificationData,
    durationYears: qualificationData.durationYears,
  };

  return {
    qualification: { degreeLevel, ...block },
    /** @deprecated Compat for single-bachelor UI — same as qualification when level is bachelor */
    bachelors: degreeLevel === "bachelor" ? block : null,
    degreeLevel,
    fields: merged.fields,
    fromCvOnly: merged.fromCvOnly,
    flags: fallback ? [...merged.flags, "heuristics_fallback"] : merged.flags,
    geminiRaw: { levelDocs: data, cv: cvGeminiRaw },
    fallback,
    geminiMeta,
    perSource: sources.map((s) => ({
      documentId: s.documentId,
      documentType: s.documentType,
      degreeLevel: s.degreeLevel ?? degreeLevel,
      extract: s.extract,
      duration: computeDuration({
        statedDuration: s.extract.statedDuration,
        start: s.extract.start,
        end: s.extract.end,
      }),
    })),
  };
}

export async function parseExperience(caseId: string) {
  const cv = await prisma.document.findFirst({
    where: { caseId, type: "CV", status: "DONE", text: { not: null } },
    orderBy: { updatedAt: "desc" },
  });
  if (!cv?.text?.trim()) {
    throw new Error("CV text is not ready");
  }

  await acquireParseSlot(config.parseRpm);

  const cvText = correctOcrEducationText(
    cv.text.slice(0, 20_000),
    cv.id,
  ).text;
  let data: Record<string, unknown>;
  let fallback = false;
  let geminiMeta: { keyUsed?: string; modelUsed?: string } = {};

  try {
    const out = await generateJsonGroqSplit({
      bodyText: cvText,
      header: "--- CV text ---",
      systemPrompt: experienceSystemPrompt(),
      responseSchema: experienceExtractSchema,
      mergeParts: mergeExperienceParts,
      maxTokens: 2048,
    });
    data = out.data;
    geminiMeta = { keyUsed: out.keyUsed, modelUsed: out.modelUsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[parse/experience] Groq failed (${message}) — using heuristics fallback`,
    );
    data = heuristicsExperienceFromText(cvText) as unknown as Record<
      string,
      unknown
    >;
    fallback = true;
  }

  let parsed = experienceExtractSchema.safeParse(data);
  if (!parsed.success || !parsed.data.rows.length) {
    if (!fallback) {
      console.warn(
        "[parse/experience] empty/invalid Groq rows — heuristics fallback",
      );
    }
    data = heuristicsExperienceFromText(cvText) as unknown as Record<
      string,
      unknown
    >;
    parsed = experienceExtractSchema.safeParse(data);
    fallback = true;
  }

  // Keep any row with employer and/or title — dates are optional.
  const rows = (parsed.success ? parsed.data.rows : [])
    .map((r) => ({
      ...r,
      employer: sanitizeExtractedLabel(r.employer),
      title: sanitizeExtractedLabel(r.title),
      start: sanitizeExtractedLabel(r.start),
      end: sanitizeExtractedLabel(r.end),
    }))
    .filter((r) => Boolean(r.employer?.trim() || r.title?.trim()));

  const sorted = [...rows].sort(
    (a, b) =>
      compareExperienceDates(b.start, b.end) -
      compareExperienceDates(a.start, a.end),
  );

  await prisma.experienceRow.deleteMany({ where: { caseId } });

  if (!sorted.length) {
    await prisma.experienceRow.create({
      data: {
        caseId,
        employer: null,
        title: null,
        start: null,
        end: null,
        domainSuggested: null,
        domainFinal: null,
        sortOrder: 0,
      },
    });
  } else {
    await prisma.experienceRow.createMany({
      data: sorted.map((row, index) => ({
        caseId,
        employer: row.employer,
        title: row.title,
        start: row.start,
        end: row.end,
        domainSuggested: row.domainMatch,
        domainFinal: row.domainMatch,
        sortOrder: index,
      })),
    });
  }

  const saved = await prisma.experienceRow.findMany({
    where: { caseId },
    orderBy: { sortOrder: "asc" },
  });

  return {
    rows: saved,
    sourceDocumentId: cv.id,
    geminiRaw: data,
    fallback,
    geminiMeta,
  };
}

function compareExperienceDates(
  start: string | null | undefined,
  end: string | null | undefined,
): number {
  const raw = end && !/present|current|ongoing/i.test(end) ? end : start;
  if (raw) {
    const m = raw.match(/(19|20)\d{2}/);
    if (m) return Number(m[0]);
  }
  return 0;
}
