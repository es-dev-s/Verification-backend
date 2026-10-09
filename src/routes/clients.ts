import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  highestDegree,
  nameFromFileName,
  resolveOccupation,
  snippet,
  verificationOf,
  type ClientFilter,
} from "../lib/clientSummary.js";
import { prisma } from "../lib/prisma.js";

/**
 * Clients list (one row per case for this browser's client id). Read-only:
 * derived from Case, Qualification, Document, Assessment and CaseReview.
 * Blank cases (no documents and no assessment) are left out — the engine
 * creates one on every fresh load.
 */

const MAX_CLIENTS = 300;

const clientsQuery = z.object({
  // "verified" is kept as an alias for "approved" (older links).
  status: z
    .enum(["all", "approved", "rejected", "unverified", "verified"])
    .default("all")
    .transform((v): ClientFilter => (v === "verified" ? "approved" : v)),
});

type StoredAssessmentJson = {
  title?: string | null;
  risk?: {
    anzscoCode?: string | null;
    title?: string | null;
    riskLevel?: string | null;
    overallPct?: number | null;
  } | null;
} | null;

type ReviewRow = {
  caseId: string;
  status: string;
  comment: string | null;
  reviewedAt: Date;
};

async function loadReviews(
  caseIds: string[],
): Promise<{ available: boolean; byCase: Map<string, ReviewRow> }> {
  const byCase = new Map<string, ReviewRow>();
  if (!caseIds.length) return { available: true, byCase };
  try {
    const rows = await prisma.caseReview.findMany({
      where: { caseId: { in: caseIds } },
      select: { caseId: true, status: true, comment: true, reviewedAt: true },
    });
    for (const r of rows) byCase.set(r.caseId, r);
    return { available: true, byCase };
  } catch (err) {
    // CaseReview migration not applied yet → everyone is unverified.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      (err.code === "P2021" || err.code === "P2022")
    ) {
      return { available: false, byCase };
    }
    throw err;
  }
}

export const clientRoutes: FastifyPluginAsync = async (app) => {
  app.get("/clients", async (req, reply) => {
    const parsed = clientsQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "status must be all, approved, rejected or unverified" });
    }
    const filter: ClientFilter = parsed.data.status;

    const cases = await prisma.case.findMany({
      where: {
        clientId: req.clientId,
        OR: [{ documents: { some: {} } }, { assessment: { isNot: null } }],
      },
      orderBy: { createdAt: "desc" },
      take: MAX_CLIENTS,
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        targetOccupation: true,
        selectedDegreeLevels: true,
        qualifications: {
          select: { degreeLevel: true, degreeTitle: true, institution: true },
        },
        documents: {
          orderBy: { createdAt: "asc" },
          select: { type: true, originalName: true },
        },
        assessment: { select: { anzscoCode: true, resultJson: true } },
      },
    });

    const reviews = await loadReviews(cases.map((c) => c.id));

    const rows = cases.map((c) => {
      const json = (c.assessment?.resultJson ?? null) as StoredAssessmentJson;
      const risk = json?.risk ?? null;
      const occupation = resolveOccupation({
        riskCode: risk?.anzscoCode,
        riskTitle: risk?.title,
        targetOccupation: c.targetOccupation,
        assessmentCode: c.assessment?.anzscoCode,
        assessmentTitle: json?.title,
      });
      const degree = highestDegree(c.qualifications, c.selectedDegreeLevels);
      const cv = c.documents.find((d) => d.type === "CV");
      const fromCv = nameFromFileName(cv?.originalName);
      const fromOther = fromCv
        ? null
        : nameFromFileName(c.documents[0]?.originalName);
      const review = reviews.byCase.get(c.id) ?? null;
      return {
        caseId: c.id,
        name: fromCv ?? fromOther ?? `Client ${c.id.slice(-6)}`,
        nameSource: fromCv ? "cv_file" : fromOther ? "document_file" : "case_id",
        anzscoCode: occupation.anzscoCode,
        occupation: occupation.title,
        degreeLevel: degree.degreeLevel,
        degreeLabel: degree.degreeLabel,
        degreeTitle: degree.degreeTitle,
        institution: degree.institution,
        riskLevel: risk?.riskLevel ?? null,
        overallPct:
          typeof risk?.overallPct === "number" && Number.isFinite(risk.overallPct)
            ? risk.overallPct
            : null,
        documentCount: c.documents.length,
        verification: verificationOf(review?.status),
        reviewStatus: review?.status ?? null,
        reviewComment: snippet(review?.comment),
        reviewedAt: review?.reviewedAt ?? null,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    });

    const counts = {
      all: rows.length,
      approved: rows.filter((r) => r.verification === "approved").length,
      rejected: rows.filter((r) => r.verification === "rejected").length,
      unverified: rows.filter((r) => r.verification === "unverified").length,
    };
    return {
      status: filter,
      counts,
      reviewsAvailable: reviews.available,
      clients:
        filter === "all" ? rows : rows.filter((r) => r.verification === filter),
    };
  });
};
