import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

const occupationBody = z.object({
  targetOccupation: z.string().min(1).max(200).nullable().optional(),
});

const draftBody = z.object({
  bachelors: z
    .object({
      degreeTitle: z.string().nullable().optional(),
      institution: z.string().nullable().optional(),
      country: z.string().nullable().optional(),
      durationYears: z.number().nullable().optional(),
      durationCalculated: z.boolean().optional(),
    })
    .optional(),
  experienceRows: z
    .array(
      z.object({
        id: z.string().optional(),
        employer: z.string().nullable().optional(),
        title: z.string().nullable().optional(),
        start: z.string().nullable().optional(),
        end: z.string().nullable().optional(),
        statedDurationYears: z.number().nullable().optional(),
        domainSuggested: z.boolean().nullable().optional(),
        domainFinal: z.boolean().nullable().optional(),
      }),
    )
    .optional(),
  fieldFinals: z
    .record(z.string(), z.string().nullable())
    .optional(),
});

export const caseRoutes: FastifyPluginAsync = async (app) => {
  app.post("/cases", async (req, reply) => {
    const clientId = req.clientId;
    const created = await prisma.case.create({
      data: { clientId },
    });
    return reply.code(201).send(created);
  });

  app.get("/cases/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await prisma.case.findFirst({
      where: { id, clientId: req.clientId },
      include: {
        documents: { orderBy: { createdAt: "asc" } },
        bachelors: true,
        experienceRows: { orderBy: { sortOrder: "asc" } },
        fieldSources: true,
        readJobs: {
          orderBy: { updatedAt: "desc" },
          take: 20,
        },
      },
    });
    if (!row) return reply.code(404).send({ error: "Case not found" });
    return row;
  });

  app.patch("/cases/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = occupationBody.parse(req.body);
    const existing = await prisma.case.findFirst({
      where: { id, clientId: req.clientId },
    });
    if (!existing) return reply.code(404).send({ error: "Case not found" });

    const updated = await prisma.case.update({
      where: { id },
      data: {
        targetOccupation:
          body.targetOccupation === undefined
            ? existing.targetOccupation
            : body.targetOccupation,
      },
    });
    return updated;
  });

  app.put("/cases/:id/draft", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = draftBody.parse(req.body);
    const existing = await prisma.case.findFirst({
      where: { id, clientId: req.clientId },
    });
    if (!existing) return reply.code(404).send({ error: "Case not found" });

    await prisma.case.update({
      where: { id },
      data: { draftJson: body },
    });

    if (body.bachelors) {
      await prisma.bachelors.upsert({
        where: { caseId: id },
        create: {
          caseId: id,
          degreeTitle: body.bachelors.degreeTitle ?? null,
          institution: body.bachelors.institution ?? null,
          country: body.bachelors.country ?? null,
          durationYears: body.bachelors.durationYears ?? null,
          durationCalculated: body.bachelors.durationCalculated ?? false,
        },
        update: {
          degreeTitle: body.bachelors.degreeTitle ?? null,
          institution: body.bachelors.institution ?? null,
          country: body.bachelors.country ?? null,
          durationYears: body.bachelors.durationYears ?? null,
          durationCalculated: body.bachelors.durationCalculated ?? false,
        },
      });
    }

    if (body.experienceRows) {
      await prisma.experienceRow.deleteMany({ where: { caseId: id } });
      if (body.experienceRows.length) {
        await prisma.experienceRow.createMany({
          data: body.experienceRows.map((row, index) => ({
            caseId: id,
            employer: row.employer ?? null,
            title: row.title ?? null,
            start: row.start ?? null,
            end: row.end ?? null,
            statedDurationYears: row.statedDurationYears ?? null,
            domainSuggested: row.domainSuggested ?? null,
            domainFinal: row.domainFinal ?? null,
            sortOrder: index,
          })),
        });
      }
    }

    if (body.fieldFinals) {
      for (const [field, finalValue] of Object.entries(body.fieldFinals)) {
        await prisma.fieldSource.upsert({
          where: { caseId_field: { caseId: id, field } },
          create: {
            caseId: id,
            field,
            finalValue,
            extractedValue: finalValue,
          },
          update: { finalValue },
        });
      }
    }

    return { ok: true };
  });

  app.post("/cases/:id/confirm", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = draftBody.parse(req.body ?? {});
    const existing = await prisma.case.findFirst({
      where: { id, clientId: req.clientId },
    });
    if (!existing) return reply.code(404).send({ error: "Case not found" });

    await prisma.case.update({
      where: { id },
      data: { draftJson: body, status: "CONFIRMED" },
    });

    if (body.bachelors) {
      await prisma.bachelors.upsert({
        where: { caseId: id },
        create: {
          caseId: id,
          degreeTitle: body.bachelors.degreeTitle ?? null,
          institution: body.bachelors.institution ?? null,
          country: body.bachelors.country ?? null,
          durationYears: body.bachelors.durationYears ?? null,
          durationCalculated: body.bachelors.durationCalculated ?? false,
        },
        update: {
          degreeTitle: body.bachelors.degreeTitle ?? null,
          institution: body.bachelors.institution ?? null,
          country: body.bachelors.country ?? null,
          durationYears: body.bachelors.durationYears ?? null,
          durationCalculated: body.bachelors.durationCalculated ?? false,
        },
      });
    }

    if (body.experienceRows) {
      await prisma.experienceRow.deleteMany({ where: { caseId: id } });
      if (body.experienceRows.length) {
        await prisma.experienceRow.createMany({
          data: body.experienceRows.map((row, index) => ({
            caseId: id,
            employer: row.employer ?? null,
            title: row.title ?? null,
            start: row.start ?? null,
            end: row.end ?? null,
            statedDurationYears: row.statedDurationYears ?? null,
            domainSuggested: row.domainSuggested ?? null,
            domainFinal: row.domainFinal ?? null,
            sortOrder: index,
          })),
        });
      }
    }

    if (body.fieldFinals) {
      for (const [field, finalValue] of Object.entries(body.fieldFinals)) {
        await prisma.fieldSource.upsert({
          where: { caseId_field: { caseId: id, field } },
          create: {
            caseId: id,
            field,
            finalValue,
            extractedValue: finalValue,
          },
          update: { finalValue },
        });
      }
    }

    const updated = await prisma.case.findUnique({
      where: { id },
      include: {
        documents: true,
        bachelors: true,
        experienceRows: { orderBy: { sortOrder: "asc" } },
        fieldSources: true,
      },
    });
    return updated;
  });
};
