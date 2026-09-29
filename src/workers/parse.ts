import { config } from "../config.js";
import { generateJson } from "../lib/gemini.js";
import { prisma } from "../lib/prisma.js";
import { acquireParseSlot } from "../lib/rateLimit.js";
import { computeDuration } from "../parse/duration.js";
import {
  heuristicsEducationMulti,
  heuristicsExperienceFromText,
  heuristicsPerSource,
} from "../parse/heuristics.js";
import { mergeEducation } from "../parse/mergeEducation.js";
import {
  educationMultiSystemPrompt,
  experienceSystemPrompt,
} from "../parse/prompts.js";
import {
  educationExtractSchema,
  educationMultiExtractSchema,
  experienceExtractSchema,
  type DocumentTypeLabel,
  type EducationExtract,
  type PerSourceEducation,
} from "../parse/schemas.js";
import { correctOcrEducationText } from "../parse/ocrCorrect.js";
import {
  sanitizeEducationExtract,
  sanitizeExtractedLabel,
} from "../parse/sanitizeExtracted.js";

/** Soft cap for Gemini before falling back to heuristics. */
const GEMINI_SOFT_DEADLINE_MS = 10_000;

const emptyExtract = (): EducationExtract => ({
  degreeTitle: null,
  institution: null,
  country: null,
  start: null,
  end: null,
  statedDuration: null,
  multipleBachelors: false,
});

export async function parseEducation(caseId: string) {
  const docs = await prisma.document.findMany({
    where: {
      caseId,
      status: "DONE",
      type: { in: ["CV", "TRANSCRIPT", "CERTIFICATE"] },
      text: { not: null },
    },
  });

  if (!docs.length) {
    return {
      bachelors: null,
      fields: {},
      fromCvOnly: false,
      flags: ["no_documents"],
      message: "No extracted documents to read",
      geminiRaw: null,
      fallback: false,
    };
  }

  const labeled = docs
    .map((doc) => {
      const raw = (doc.text ?? "").trim();
      if (!raw) return null;
      // Re-apply OCR cleanup for docs extracted before the corrector existed
      const { text } = correctOcrEducationText(raw, doc.id);
      return {
        documentId: doc.id,
        documentType: doc.type as DocumentTypeLabel,
        text: text.slice(0, 8_000),
      };
    })
    .filter((d): d is NonNullable<typeof d> => d != null);

  if (!labeled.length) {
    return {
      bachelors: null,
      fields: {},
      fromCvOnly: false,
      flags: ["no_text"],
      message: "No extracted text to read",
      geminiRaw: null,
      fallback: false,
    };
  }

  await acquireParseSlot(config.parseRpm);

  const userPrompt = labeled
    .map(
      (d) =>
        `=== SOURCE documentId=${d.documentId} documentType=${d.documentType} ===\n${d.text}`,
    )
    .join("\n\n");

  let data: Record<string, unknown>;
  let fallback = false;
  let geminiMeta: { keyUsed?: string; modelUsed?: string } = {};

  try {
    const out = await generateJson(
      userPrompt,
      educationMultiSystemPrompt(),
      {
        deadlineMs: Date.now() + GEMINI_SOFT_DEADLINE_MS,
        maxTokens: 2048,
        responseSchema: educationMultiExtractSchema,
      },
    );
    data = out.data;
    geminiMeta = { keyUsed: out.keyUsed, modelUsed: out.modelUsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[parse/education] Gemini failed (${message}) — using heuristics fallback`,
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

  let sources: PerSourceEducation[] = labeled.map((d) => {
    const raw = byId.get(d.documentId);
    if (!raw) {
      return {
        documentId: d.documentId,
        documentType: d.documentType,
        extract: emptyExtract(),
      };
    }
    const parsed = educationExtractSchema.safeParse(raw);
    const extract = parsed.success ? parsed.data : emptyExtract();
    return {
      documentId: d.documentId,
      documentType: d.documentType,
      extract: sanitizeEducationExtract(extract),
    };
  });

  // If Gemini returned empty/unusable sources, fall back to heuristics
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
      "[parse/education] empty Gemini fields — heuristics fallback",
    );
    sources = heuristicsPerSource(labeled).map((s) => ({
      ...s,
      extract: sanitizeEducationExtract(s.extract),
    }));
    data = heuristicsEducationMulti(labeled) as unknown as Record<
      string,
      unknown
    >;
    fallback = true;
  }

  const merged = mergeEducation(sources);
  const durationYears =
    merged.fields.durationYears.value != null
      ? Number(merged.fields.durationYears.value)
      : null;

  await prisma.bachelors.upsert({
    where: { caseId },
    create: {
      caseId,
      degreeTitle: merged.fields.degreeTitle.value,
      institution: merged.fields.institution.value,
      country: merged.fields.country.value,
      durationYears: Number.isFinite(durationYears as number)
        ? (durationYears as number)
        : null,
      durationCalculated: merged.durationCalculated,
    },
    update: {
      degreeTitle: merged.fields.degreeTitle.value,
      institution: merged.fields.institution.value,
      country: merged.fields.country.value,
      durationYears: Number.isFinite(durationYears as number)
        ? (durationYears as number)
        : null,
      durationCalculated: merged.durationCalculated,
    },
  });

  const fieldEntries = Object.entries(merged.fields) as Array<
    [keyof typeof merged.fields, (typeof merged.fields)[keyof typeof merged.fields]]
  >;

  for (const [field, meta] of fieldEntries) {
    await prisma.fieldSource.upsert({
      where: { caseId_field: { caseId, field } },
      create: {
        caseId,
        field,
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

  return {
    bachelors: {
      degreeTitle: merged.fields.degreeTitle.value,
      institution: merged.fields.institution.value,
      country: merged.fields.country.value,
      durationYears: Number.isFinite(durationYears as number)
        ? durationYears
        : null,
      durationCalculated: merged.durationCalculated,
    },
    fields: merged.fields,
    fromCvOnly: merged.fromCvOnly,
    flags: fallback ? [...merged.flags, "heuristics_fallback"] : merged.flags,
    geminiRaw: data,
    fallback,
    geminiMeta,
    perSource: sources.map((s) => ({
      documentId: s.documentId,
      documentType: s.documentType,
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
    const out = await generateJson(
      `--- CV text ---\n${cvText}`,
      experienceSystemPrompt(),
      {
        deadlineMs: Date.now() + GEMINI_SOFT_DEADLINE_MS,
        maxTokens: 2048,
        responseSchema: experienceExtractSchema,
      },
    );
    data = out.data;
    geminiMeta = { keyUsed: out.keyUsed, modelUsed: out.modelUsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[parse/experience] Gemini failed (${message}) — using heuristics fallback`,
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
        "[parse/experience] empty/invalid Gemini rows — heuristics fallback",
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
      compareExperienceDates(b.start, b.end, b.statedDurationYears) -
      compareExperienceDates(a.start, a.end, a.statedDurationYears),
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
        statedDurationYears: null,
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
        statedDurationYears:
          row.statedDurationYears != null &&
          Number.isFinite(row.statedDurationYears)
            ? row.statedDurationYears
            : null,
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
  statedDurationYears?: number | null,
): number {
  const raw = end && !/present|current|ongoing/i.test(end) ? end : start;
  if (raw) {
    const m = raw.match(/(19|20)\d{2}/);
    if (m) return Number(m[0]);
  }
  // Duration-only rows sort below dated roles but above blank
  if (statedDurationYears != null && statedDurationYears > 0) return 1;
  return 0;
}
