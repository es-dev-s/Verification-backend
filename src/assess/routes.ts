import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { assessCase } from "../assess/assessCase.js";
import { prisma } from "../lib/prisma.js";

const assessBody = z.object({
  force: z.boolean().optional(),
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
