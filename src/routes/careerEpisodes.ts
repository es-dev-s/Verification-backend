import type { FastifyPluginAsync } from "fastify";
import { ProjectSource, type DocumentFormat } from "@prisma/client";
import { z } from "zod";
import { config } from "../config.js";
import { sha256 } from "../lib/blob.js";
import { detectFormatFromBytes } from "../lib/formats.js";
import {
  EPISODE_EVIDENCE_FIELDS,
  parseEvidenceFlags,
  type EpisodeEvidenceField,
} from "../lib/episodeEvidence.js";
import { prisma } from "../lib/prisma.js";
import { parseProjectSource } from "../lib/projectSource.js";
import { checkRateLimit } from "../lib/rateLimit.js";

/**
 * Career episodes / projects (Step 1). Upload + save only: files are stored in the
 * CareerEpisode table and are never queued for OCR, parsing, assessment or risk.
 */

const MAX_EPISODES_PER_CASE = 20;

/** Everything except the file bytes. */
export const careerEpisodeSelect = {
  id: true,
  caseId: true,
  projectSource: true,
  experienceRowId: true,
  experienceLabel: true,
  originalName: true,
  format: true,
  sizeBytes: true,
  sha256: true,
  sortOrder: true,
  hasCalculations: true,
  hasDrawingsCad: true,
  hasDataTables: true,
  hasSiteProductImages: true,
  hasStandardsReferenced: true,
  hasQuantifiableOutcomes: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const careerEpisodeOrder = [
  { sortOrder: "asc" as const },
  { createdAt: "asc" as const },
];

const CONTENT_TYPES: Record<DocumentFormat, string> = {
  PDF: "application/pdf",
  PNG: "image/png",
  JPG: "image/jpeg",
  DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function fieldValue(
  fields: Record<string, { value?: string } | Array<{ value?: string }> | undefined>,
  key: string,
): string {
  const t = fields[key];
  if (!t) return "";
  if (Array.isArray(t)) return String(t[0]?.value ?? "");
  return String(t.value ?? "");
}

async function listEpisodes(caseId: string) {
  return prisma.careerEpisode.findMany({
    where: { caseId },
    select: careerEpisodeSelect,
    orderBy: careerEpisodeOrder,
  });
}

/** Keep the id only if it is a current experience row on this case. */
async function resolveExperienceRowId(
  caseId: string,
  raw: string | null | undefined,
): Promise<string | null> {
  const id = (raw ?? "").trim();
  if (!id) return null;
  const row = await prisma.experienceRow.findFirst({
    where: { id, caseId },
    select: { id: true },
  });
  return row?.id ?? null;
}

const patchBody = z.object({
  projectSource: z.nativeEnum(ProjectSource).nullable().optional(),
  experienceRowId: z.string().max(100).nullable().optional(),
  experienceLabel: z.string().max(300).nullable().optional(),
  hasCalculations: z.boolean().optional(),
  hasDrawingsCad: z.boolean().optional(),
  hasDataTables: z.boolean().optional(),
  hasSiteProductImages: z.boolean().optional(),
  hasStandardsReferenced: z.boolean().optional(),
  hasQuantifiableOutcomes: z.boolean().optional(),
});

export const careerEpisodeRoutes: FastifyPluginAsync = async (app) => {
  app.get("/cases/:id/career-episodes", async (req, reply) => {
    const { id: caseId } = req.params as { id: string };
    const caseRow = await prisma.case.findFirst({
      where: { id: caseId, clientId: req.clientId },
      select: { id: true },
    });
    if (!caseRow) return reply.code(404).send({ error: "Case not found" });
    return { episodes: await listEpisodes(caseId) };
  });

  app.post("/cases/:id/career-episodes", async (req, reply) => {
    const { id: caseId } = req.params as { id: string };
    const caseRow = await prisma.case.findFirst({
      where: { id: caseId, clientId: req.clientId },
      select: { id: true },
    });
    if (!caseRow) return reply.code(404).send({ error: "Case not found" });

    const rl = await checkRateLimit(
      `upload:${req.clientId}`,
      config.uploadsPerMinute,
    );
    if (!rl.ok) {
      return reply.code(429).send({ error: "Upload rate limit exceeded" });
    }

    const count = await prisma.careerEpisode.count({ where: { caseId } });
    if (count >= MAX_EPISODES_PER_CASE) {
      return reply.code(400).send({
        error: `A case can have at most ${MAX_EPISODES_PER_CASE} career episodes`,
      });
    }

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "No file uploaded" });

    const fields = file.fields as Record<
      string,
      { value?: string } | Array<{ value?: string }> | undefined
    >;
    const query = req.query as {
      projectSource?: string;
      experienceRowId?: string;
      experienceLabel?: string;
    } & Partial<Record<EpisodeEvidenceField, string>>;
    const projectSourceRaw =
      String(query.projectSource ?? "") || fieldValue(fields, "projectSource");
    const projectSource = parseProjectSource(projectSourceRaw);
    if (projectSource === undefined) {
      return reply.code(400).send({
        error:
          "projectSource must be WORK_BASED, ACADEMIC_PERSONAL, or FIRM_PREPARED",
      });
    }
    const experienceRowId = await resolveExperienceRowId(
      caseId,
      String(query.experienceRowId ?? "") ||
        fieldValue(fields, "experienceRowId"),
    );
    const experienceLabel =
      (
        String(query.experienceLabel ?? "") ||
        fieldValue(fields, "experienceLabel")
      )
        .trim()
        .slice(0, 300) || null;
    // Evidence checkboxes: query string or multipart fields, "true"/"false" (missing = false).
    const evidenceResult = parseEvidenceFlags(
      (field) => String(query[field] ?? "") || fieldValue(fields, field),
    );
    if (!evidenceResult.ok) {
      return reply.code(400).send({
        error: `${evidenceResult.field} must be true or false`,
      });
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of file.file) {
      total += chunk.length;
      if (total > config.maxUploadBytes) {
        return reply
          .code(400)
          .send({ error: "File exceeds the 10 MB size limit" });
      }
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (!bytes.length) return reply.code(400).send({ error: "Empty file" });

    const format = detectFormatFromBytes(bytes);
    if (!format) {
      return reply.code(400).send({
        error:
          "Unrecognized file content. Accepted formats: PDF, PNG, JPG, DOCX (validated by magic bytes, not extension)",
      });
    }

    const last = await prisma.careerEpisode.findFirst({
      where: { caseId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });

    // Stored only — deliberately NOT queued for extraction / parsing.
    const episode = await prisma.careerEpisode.create({
      data: {
        caseId,
        projectSource,
        experienceRowId,
        experienceLabel,
        ...evidenceResult.evidence,
        originalName: file.filename || `career-episode.${format.toLowerCase()}`,
        format,
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
        fileData: bytes,
        sortOrder: (last?.sortOrder ?? -1) + 1,
      },
      select: careerEpisodeSelect,
    });

    return reply
      .code(201)
      .send({ episode, episodes: await listEpisodes(caseId) });
  });

  app.patch("/cases/:id/career-episodes/:episodeId", async (req, reply) => {
    const { id: caseId, episodeId } = req.params as {
      id: string;
      episodeId: string;
    };
    const caseRow = await prisma.case.findFirst({
      where: { id: caseId, clientId: req.clientId },
      select: { id: true },
    });
    if (!caseRow) return reply.code(404).send({ error: "Case not found" });

    const parsed = patchBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid career episode update" });
    }
    const existing = await prisma.careerEpisode.findFirst({
      where: { id: episodeId, caseId },
      select: { id: true },
    });
    if (!existing) {
      return reply.code(404).send({ error: "Career episode not found" });
    }

    const body = parsed.data;
    const data: {
      projectSource?: ProjectSource | null;
      experienceRowId?: string | null;
      experienceLabel?: string | null;
    } & Partial<Record<EpisodeEvidenceField, boolean>> = {};
    if (body.projectSource !== undefined) data.projectSource = body.projectSource;
    if (body.experienceRowId !== undefined) {
      data.experienceRowId = await resolveExperienceRowId(
        caseId,
        body.experienceRowId,
      );
    }
    if (body.experienceLabel !== undefined) {
      data.experienceLabel = body.experienceLabel?.trim() || null;
    }
    for (const field of EPISODE_EVIDENCE_FIELDS) {
      const value = body[field];
      if (value !== undefined) data[field] = value;
    }

    const episode = await prisma.careerEpisode.update({
      where: { id: episodeId },
      data,
      select: careerEpisodeSelect,
    });
    return { episode, episodes: await listEpisodes(caseId) };
  });

  app.delete("/cases/:id/career-episodes/:episodeId", async (req, reply) => {
    const { id: caseId, episodeId } = req.params as {
      id: string;
      episodeId: string;
    };
    const caseRow = await prisma.case.findFirst({
      where: { id: caseId, clientId: req.clientId },
      select: { id: true },
    });
    if (!caseRow) return reply.code(404).send({ error: "Case not found" });

    const deleted = await prisma.careerEpisode.deleteMany({
      where: { id: episodeId, caseId },
    });
    if (!deleted.count) {
      return reply.code(404).send({ error: "Career episode not found" });
    }
    return { ok: true, episodes: await listEpisodes(caseId) };
  });

  /** Download the stored file (requires the same X-Client-Id header). */
  app.get("/cases/:id/career-episodes/:episodeId/file", async (req, reply) => {
    const { id: caseId, episodeId } = req.params as {
      id: string;
      episodeId: string;
    };
    const caseRow = await prisma.case.findFirst({
      where: { id: caseId, clientId: req.clientId },
      select: { id: true },
    });
    if (!caseRow) return reply.code(404).send({ error: "Case not found" });

    const episode = await prisma.careerEpisode.findFirst({
      where: { id: episodeId, caseId },
      select: { originalName: true, format: true, fileData: true },
    });
    if (!episode) {
      return reply.code(404).send({ error: "Career episode not found" });
    }
    const safeName = episode.originalName.replace(/["\r\n]/g, "_");
    return reply
      .header("Content-Type", CONTENT_TYPES[episode.format])
      .header("Content-Disposition", `attachment; filename="${safeName}"`)
      .send(Buffer.from(episode.fileData));
  });
};
