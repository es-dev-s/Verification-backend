import type { FastifyPluginAsync } from "fastify";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { parseEducation, parseExperience } from "../workers/parse.js";

function buildJobId(
  caseId: string,
  section: "EDUCATION" | "EXPERIENCE",
  inputHash: string,
): string {
  return createHash("sha256")
    .update(`${caseId}|${section}|${inputHash}`)
    .digest("hex")
    .slice(0, 32);
}

function inputHashFor(
  caseId: string,
  section: "EDUCATION" | "EXPERIENCE",
  parts: string[],
): string {
  return createHash("sha256")
    .update([caseId, section, ...parts].join("|"))
    .digest("hex");
}

export const jobRoutes: FastifyPluginAsync = async (app) => {
  app.post("/cases/:id/read/:section", async (req, reply) => {
    const { id: caseId, section: sectionRaw } = req.params as {
      id: string;
      section: string;
    };
    const section =
      sectionRaw.toUpperCase() === "EXPERIENCE" ? "EXPERIENCE" : "EDUCATION";

    const caseRow = await prisma.case.findFirst({
      where: { id: caseId, clientId: req.clientId },
      include: { documents: true },
    });
    if (!caseRow) return reply.code(404).send({ error: "Case not found" });

    const rl = await checkRateLimit(
      `read:${req.clientId}`,
      config.readsPerMinute,
    );
    if (!rl.ok) {
      return reply.code(429).send({ error: "Read rate limit exceeded" });
    }

    // Cap concurrent in-flight Reads per case (sync requests still mark RUNNING)
    const inFlight = await prisma.readJob.count({
      where: {
        caseId,
        status: "RUNNING",
      },
    });
    if (inFlight >= config.maxInFlightJobsPerCase) {
      return reply
        .code(429)
        .send({ error: "Too many jobs in flight for this case" });
    }

    let hash: string;
    if (section === "EDUCATION") {
      const needed = caseRow.documents.filter((d) =>
        ["CV", "TRANSCRIPT", "CERTIFICATE"].includes(d.type),
      );
      if (!needed.length) {
        return reply
          .code(400)
          .send({ error: "Upload at least one document before Read" });
      }
      const pending = needed.filter((d) =>
        ["QUEUED", "EXTRACTING"].includes(d.status),
      );
      if (pending.length) {
        return reply.code(409).send({
          error: "Documents are still queued or extracting",
          pending: pending.map((d) => d.id),
        });
      }
      const ready = needed.filter((d) => d.status === "DONE" && d.text);
      if (!ready.length) {
        return reply
          .code(400)
          .send({ error: "No successfully extracted documents to read" });
      }
      hash = inputHashFor(
        caseId,
        "EDUCATION",
        ready.map((d) => `${d.id}:${d.sha256}:${d.text?.length ?? 0}`).sort(),
      );
    } else {
      const cvs = caseRow.documents.filter((d) => d.type === "CV");
      if (!cvs.length) {
        return reply.code(400).send({ error: "Upload a CV before Read" });
      }
      const pending = cvs.filter((d) =>
        ["QUEUED", "EXTRACTING"].includes(d.status),
      );
      if (pending.length) {
        return reply.code(409).send({
          error: "CV is still queued or extracting",
          pending: pending.map((d) => d.id),
        });
      }
      const ready = cvs.filter((d) => d.status === "DONE" && d.text);
      if (!ready.length) {
        return reply.code(400).send({ error: "CV extraction is not ready" });
      }
      hash = inputHashFor(
        caseId,
        "EXPERIENCE",
        ready.map((d) => `${d.id}:${d.sha256}:${d.text?.length ?? 0}`).sort(),
      );
    }

    const jobId = buildJobId(caseId, section, hash);

    const existing = await prisma.readJob.findUnique({ where: { id: jobId } });
    if (existing && existing.status === "DONE" && !existing.stale) {
      console.log(
        `[read] ${section} case=${caseId} job=${jobId} CACHE HIT — no Gemini call`,
      );
      return {
        jobId: existing.id,
        status: "DONE" as const,
        cached: true,
        result: existing.resultJson,
      };
    }

    console.log(`[read] ${section} case=${caseId} job=${jobId} starting sync Gemini parse…`);

    await prisma.readJob.upsert({
      where: { id: jobId },
      create: {
        id: jobId,
        caseId,
        section,
        inputHash: hash,
        status: "RUNNING",
        stale: false,
      },
      update: {
        status: "RUNNING",
        error: null,
        stale: false,
        resultJson: undefined,
      },
    });

    try {
      const result =
        section === "EDUCATION"
          ? await parseEducation(caseId)
          : await parseExperience(caseId);

      const resultJson = JSON.parse(JSON.stringify(result)) as object;

      console.log(
        `[read] ${section} case=${caseId} job=${jobId} DONE — returning to UI`,
      );
      console.log(
        "[read] response.result:\n" + JSON.stringify(resultJson, null, 2),
      );

      await prisma.readJob.update({
        where: { id: jobId },
        data: {
          status: "DONE",
          resultJson,
          stale: false,
          error: null,
        },
      });

      return {
        jobId,
        status: "DONE" as const,
        cached: false,
        result: resultJson,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.readJob.update({
        where: { id: jobId },
        data: { status: "FAILED", error: message },
      });
      req.log.error({ err, jobId, section }, "sync read failed");
      return reply.code(502).send({
        jobId,
        status: "FAILED",
        error: message,
      });
    }
  });

  app.get("/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await prisma.readJob.findUnique({
      where: { id },
      include: { case: { select: { clientId: true } } },
    });
    if (!job || job.case.clientId !== req.clientId) {
      return reply.code(404).send({ error: "Job not found" });
    }
    return {
      id: job.id,
      caseId: job.caseId,
      section: job.section,
      status: job.status,
      error: job.error,
      stale: job.stale,
      result: job.resultJson,
      updatedAt: job.updatedAt,
    };
  });
};
