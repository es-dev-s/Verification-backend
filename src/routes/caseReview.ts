import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { Prisma, CaseReviewStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

/**
 * Step 6 — manual approve / reject decision for a case (the case is the client).
 * One row per case; saving again overwrites the decision and its timestamp.
 */

export const REVIEW_COMMENT_MAX = 2000;

const reviewBody = z.object({
  status: z.enum([CaseReviewStatus.APPROVED, CaseReviewStatus.REJECTED]),
  comment: z.string().max(REVIEW_COMMENT_MAX).nullable().optional(),
});

const reviewSelect = {
  status: true,
  comment: true,
  reviewedAt: true,
  updatedAt: true,
} as const;

/** Table missing (migration not applied yet) → clear 503 instead of a 500. */
function sendStorageError(reply: FastifyReply, err: unknown) {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    (err.code === "P2021" || err.code === "P2022")
  ) {
    return reply.code(503).send({
      error:
        "Approval storage is not set up yet. Apply the database migration (npx prisma migrate deploy) and restart the API.",
    });
  }
  throw err;
}

export const caseReviewRoutes: FastifyPluginAsync = async (app) => {
  app.get("/cases/:id/review", async (req, reply) => {
    const { id: caseId } = req.params as { id: string };
    const caseRow = await prisma.case.findFirst({
      where: { id: caseId, clientId: req.clientId },
      select: { id: true },
    });
    if (!caseRow) return reply.code(404).send({ error: "Case not found" });
    try {
      const review = await prisma.caseReview.findUnique({
        where: { caseId },
        select: reviewSelect,
      });
      return { review };
    } catch (err) {
      return sendStorageError(reply, err);
    }
  });

  app.put("/cases/:id/review", async (req, reply) => {
    const { id: caseId } = req.params as { id: string };
    const caseRow = await prisma.case.findFirst({
      where: { id: caseId, clientId: req.clientId },
      select: { id: true },
    });
    if (!caseRow) return reply.code(404).send({ error: "Case not found" });

    const parsed = reviewBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: `Choose Approve or Reject; the comment can be at most ${REVIEW_COMMENT_MAX} characters`,
      });
    }
    const status = parsed.data.status;
    const comment = parsed.data.comment?.trim() || null;
    const reviewedAt = new Date();

    try {
      const review = await prisma.caseReview.upsert({
        where: { caseId },
        create: { caseId, status, comment, reviewedAt },
        update: { status, comment, reviewedAt },
        select: reviewSelect,
      });
      return { review };
    } catch (err) {
      return sendStorageError(reply, err);
    }
  });
};
