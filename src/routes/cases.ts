import type { FastifyPluginAsync } from "fastify";
import { DegreeLevel } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

const degreeLevelSchema = z.nativeEnum(DegreeLevel);

const patchBody = z.object({
  targetOccupation: z.string().min(1).max(200).nullable().optional(),
  selectedDegreeLevels: z.array(degreeLevelSchema).optional(),
  engineeringTitledDegree: z.boolean().nullable().optional(),
});

const qualificationDraftSchema = z.object({
  degreeLevel: degreeLevelSchema,
  degreeTitle: z.string().nullable().optional(),
  institution: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  durationYears: z.number().nullable().optional(),
  durationCalculated: z.boolean().optional(),
});

const draftBody = z.object({
  /** Legacy single-block shape — mapped to Qualification bachelor when present. */
  bachelors: z
    .object({
      degreeTitle: z.string().nullable().optional(),
      institution: z.string().nullable().optional(),
      country: z.string().nullable().optional(),
      durationYears: z.number().nullable().optional(),
      durationCalculated: z.boolean().optional(),
    })
    .optional(),
  qualifications: z.array(qualificationDraftSchema).optional(),
  experienceRows: z
    .array(
      z.object({
        id: z.string().optional(),
        employer: z.string().nullable().optional(),
        title: z.string().nullable().optional(),
        start: z.string().nullable().optional(),
        end: z.string().nullable().optional(),
        domainSuggested: z.boolean().nullable().optional(),
        domainFinal: z.boolean().nullable().optional(),
      }),
    )
    .optional(),
  engineeringTitledDegree: z.boolean().nullable().optional(),
  /** Legacy flat map — applied at bachelor when no degreeLevel entries are sent. */
  fieldFinals: z
    .record(z.string(), z.string().nullable())
    .optional(),
  /** Preferred: per-level field finals. */
  fieldFinalEntries: z
    .array(
      z.object({
        field: z.string(),
        degreeLevel: degreeLevelSchema,
        finalValue: z.string().nullable(),
      }),
    )
    .optional(),
});

async function upsertFieldFinals(
  caseId: string,
  body: z.infer<typeof draftBody>,
) {
  if (body.fieldFinalEntries?.length) {
    for (const entry of body.fieldFinalEntries) {
      await prisma.fieldSource.upsert({
        where: {
          caseId_field_degreeLevel: {
            caseId,
            field: entry.field,
            degreeLevel: entry.degreeLevel,
          },
        },
        create: {
          caseId,
          field: entry.field,
          degreeLevel: entry.degreeLevel,
          finalValue: entry.finalValue,
          extractedValue: entry.finalValue,
        },
        update: { finalValue: entry.finalValue },
      });
    }
    return;
  }
  if (!body.fieldFinals) return;
  for (const [field, finalValue] of Object.entries(body.fieldFinals)) {
    await prisma.fieldSource.upsert({
      where: {
        caseId_field_degreeLevel: {
          caseId,
          field,
          degreeLevel: "bachelor",
        },
      },
      create: {
        caseId,
        field,
        degreeLevel: "bachelor",
        finalValue,
        extractedValue: finalValue,
      },
      update: { finalValue },
    });
  }
}

async function upsertQualifications(
  caseId: string,
  body: z.infer<typeof draftBody>,
) {
  const rows: z.infer<typeof qualificationDraftSchema>[] = [
    ...(body.qualifications ?? []),
  ];
  if (body.bachelors && !rows.some((r) => r.degreeLevel === "bachelor")) {
    rows.push({ degreeLevel: "bachelor", ...body.bachelors });
  }
  for (const q of rows) {
    await prisma.qualification.upsert({
      where: {
        caseId_degreeLevel: { caseId, degreeLevel: q.degreeLevel },
      },
      create: {
        caseId,
        degreeLevel: q.degreeLevel,
        degreeTitle: q.degreeTitle ?? null,
        institution: q.institution ?? null,
        country: q.country ?? null,
        durationYears: q.durationYears ?? null,
        durationCalculated: q.durationCalculated ?? false,
      },
      update: {
        degreeTitle: q.degreeTitle ?? null,
        institution: q.institution ?? null,
        country: q.country ?? null,
        durationYears: q.durationYears ?? null,
        durationCalculated: q.durationCalculated ?? false,
      },
    });
  }
}

function caseInclude() {
  return {
    documents: { orderBy: { createdAt: "asc" as const } },
    qualifications: { orderBy: { degreeLevel: "asc" as const } },
    experienceRows: { orderBy: { sortOrder: "asc" as const } },
    fieldSources: true,
    assessment: true,
    readJobs: {
      orderBy: { updatedAt: "desc" as const },
      take: 20,
    },
  };
}

/** Temporary compat: expose bachelor Qualification as `bachelors` for existing UI. */
function withLegacyBachelors<T extends {
  qualifications: Array<{
    degreeLevel: DegreeLevel;
    degreeTitle: string | null;
    institution: string | null;
    country: string | null;
    durationYears: number | null;
    durationCalculated: boolean;
  }>;
  assessment?: {
    resultJson: unknown;
  } | null;
}>(row: T) {
  const bachelor = row.qualifications.find((q) => q.degreeLevel === "bachelor");
  return {
    ...row,
    bachelors: bachelor
      ? {
          degreeTitle: bachelor.degreeTitle,
          institution: bachelor.institution,
          country: bachelor.country,
          durationYears: bachelor.durationYears,
          durationCalculated: bachelor.durationCalculated,
        }
      : null,
    assessment: (row.assessment?.resultJson as object | null) ?? null,
  };
}

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
      include: caseInclude(),
    });
    if (!row) return reply.code(404).send({ error: "Case not found" });
    return withLegacyBachelors(row);
  });

  app.patch("/cases/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchBody.parse(req.body);
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
        selectedDegreeLevels:
          body.selectedDegreeLevels === undefined
            ? existing.selectedDegreeLevels
            : body.selectedDegreeLevels,
        engineeringTitledDegree:
          body.engineeringTitledDegree === undefined
            ? existing.engineeringTitledDegree
            : body.engineeringTitledDegree,
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
      data: {
        draftJson: body,
        ...(body.engineeringTitledDegree !== undefined
          ? { engineeringTitledDegree: body.engineeringTitledDegree }
          : {}),
      },
    });

    await upsertQualifications(id, body);

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
            domainSuggested: row.domainSuggested ?? null,
            domainFinal: row.domainFinal ?? null,
            sortOrder: index,
          })),
        });
      }
    }

    await upsertFieldFinals(id, body);

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
      data: {
        draftJson: body,
        status: "CONFIRMED",
        ...(body.engineeringTitledDegree !== undefined
          ? { engineeringTitledDegree: body.engineeringTitledDegree }
          : {}),
      },
    });

    await upsertQualifications(id, body);

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
            domainSuggested: row.domainSuggested ?? null,
            domainFinal: row.domainFinal ?? null,
            sortOrder: index,
          })),
        });
      }
    }

    await upsertFieldFinals(id, body);

    // Clear extracted text after confirm (retention) — all docs on the case
    await prisma.document.updateMany({
      where: { caseId: id },
      data: { text: null },
    });

    const updated = await prisma.case.findUnique({
      where: { id },
      include: caseInclude(),
    });
    return updated ? withLegacyBachelors(updated) : updated;
  });
};
