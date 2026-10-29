import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { assessCase } from "../assess/assessCase.js";
import { prisma } from "../lib/prisma.js";
import { getTranscriptData, saveTranscriptOverrides } from "./transcriptData.js";

const assessBody = z.object({
  force: z.boolean().optional(),
});

const degreeLevelSchema = z.enum(["diploma", "advanced_diploma", "bachelor", "master", "phd"]);
const nullableNumber = (min: number, max: number) => z.number().min(min).max(max).nullable().optional();

/** Transcript data overrides; null clears a value (the transcript value is used again). */
const overridesBody = z.object({
  degreeLevel: degreeLevelSchema,
  countedYears: nullableNumber(0.5, 12),
  creditTotal: nullableNumber(0, 10_000),
  finalProject: z.string().trim().max(300).nullable().optional(),
  /** 0–1. */
  engineeringShare: nullableNumber(0, 1),
});

export const assessRoutes: FastifyPluginAsync = async (app) => {
  app.post("/cases/:id/assess", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = assessBody.parse(req.body ?? {});

    const existing = await prisma.case.findFirst({
      where: { id, clientId: req.clientId },
    });
    if (!existing) return reply.code(404).send({ error: "Case not found" });

    try {
      const result = await assessCase(id, { force: body.force });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, "assess failed");
      return reply.code(500).send({ error: message });
    }
  });

  // Transcript data (wizard step 2): summary only, subjects are never returned.
  app.get("/cases/:id/transcript-data", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.case.findFirst({ where: { id, clientId: req.clientId } });
    if (!existing) return reply.code(404).send({ error: "Case not found" });
    return getTranscriptData(id, { mode: "read" });
  });

  app.post("/cases/:id/transcript-data", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = assessBody.parse(req.body ?? {});
    const existing = await prisma.case.findFirst({ where: { id, clientId: req.clientId } });
    if (!existing) return reply.code(404).send({ error: "Case not found" });
    try {
      return await getTranscriptData(id, { mode: "extract", force: body.force });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, "transcript data failed");
      return reply.code(500).send({ error: message });
    }
  });

  app.put("/cases/:id/transcript-data/overrides", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = overridesBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid values" });
    const existing = await prisma.case.findFirst({ where: { id, clientId: req.clientId } });
    if (!existing) return reply.code(404).send({ error: "Case not found" });
    const { degreeLevel, ...patch } = parsed.data;
    await saveTranscriptOverrides(id, degreeLevel, patch);
    return getTranscriptData(id, { mode: "read" });
  });

  app.get("/cases/:id/assess", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.case.findFirst({
      where: { id, clientId: req.clientId },
      include: { assessment: true },
    });
    if (!existing) return reply.code(404).send({ error: "Case not found" });
    if (!existing.assessment?.resultJson) {
      return reply.code(404).send({ error: "No assessment yet" });
    }
    return existing.assessment.resultJson;
  });
};
