import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../lib/prisma.js";
import {
  getStoredRisk,
  patchRiskCompetence,
  runRiskAssessment,
} from "./runRisk.js";
import { riskPatchBodySchema, riskPostBodySchema } from "./schemas.js";

export const riskRoutes: FastifyPluginAsync = async (app) => {
  app.post("/cases/:id/risk", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = riskPostBodySchema.parse(req.body ?? {});

    const existing = await prisma.case.findFirst({
      where: { id, clientId: req.clientId },
    });
    if (!existing) return reply.code(404).send({ error: "Case not found" });

    try {
      return await runRiskAssessment(id, {
        anzscoCode: body.anzscoCode,
        title: body.title,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, "risk assessment failed");
      const status =
        /assessment|not found|ANZSCO/i.test(message) ? 400 : 500;
      return reply.code(status).send({ error: message });
    }
  });

  app.get("/cases/:id/risk", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.case.findFirst({
      where: { id, clientId: req.clientId },
    });
    if (!existing) return reply.code(404).send({ error: "Case not found" });

    const risk = await getStoredRisk(id);
    if (!risk) return reply.code(404).send({ error: "No risk result yet" });
    return risk;
  });

  app.patch("/cases/:id/risk", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = riskPatchBodySchema.parse(req.body ?? {});

    const existing = await prisma.case.findFirst({
      where: { id, clientId: req.clientId },
    });
    if (!existing) return reply.code(404).send({ error: "Case not found" });

    try {
      return await patchRiskCompetence(id, body.competence);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });
};
