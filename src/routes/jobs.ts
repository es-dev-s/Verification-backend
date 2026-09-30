import type { FastifyPluginAsync } from "fastify";
import { createHash } from "node:crypto";
import { DegreeLevel } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import type { DegreeLevelLabel } from "../parse/schemas.js";
import { documentMatchesDegreeLevel } from "../parse/documentScope.js";
import { parseEducation, parseExperience } from "../workers/parse.js";

const DEGREE_LEVELS = new Set<string>(Object.values(DegreeLevel));

function buildJobId(
  caseId: string,
  section: "EDUCATION" | "EXPERIENCE",
  inputHash: string,
  degreeLevel?: string | null,
): string {
  return createHash("sha256")
    .update(`${caseId}|${section}|${degreeLevel ?? ""}|${inputHash}`)
    .digest("hex")
    .slice(0, 32);
}

function inputHashFor(
  caseId: string,
  section: "EDUCATION" | "EXPERIENCE",
  parts: string[],
  degreeLevel?: string | null,
): string {
  return createHash("sha256")
    .update([caseId, section, degreeLevel ?? "", ...parts].join("|"))
    .digest("hex");
}

function parseDegreeLevelParam(raw: string | undefined): DegreeLevelLabel | null {
  if (!raw?.trim()) return null;
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (DEGREE_LEVELS.has(normalized)) return normalized as DegreeLevelLabel;
  return null;
}

async function runEducationRead(
  req: { clientId: string; log: { error: (o: unknown, m: string) => void } },
  reply: {
    code: (n: number) => { send: (b: unknown) => unknown };
  },
  caseId: string,
  degreeLevel: DegreeLevelLabel,
) {
  const caseRow = await prisma.case.findFirst({
    where: { id: caseId, clientId: req.clientId },
    include: { documents: true },
  });
  if (!caseRow) return reply.code(404).send({ error: "Case not found" });

  if (
    caseRow.selectedDegreeLevels.length &&
    !caseRow.selectedDegreeLevels.includes(degreeLevel)
  ) {
    return reply.code(400).send({
      error: `degreeLevel "${degreeLevel}" is not in this case's selectedDegreeLevels`,
      selectedDegreeLevels: caseRow.selectedDegreeLevels,
    });
  }

  const rl = await checkRateLimit(
    `read:${req.clientId}`,
    config.readsPerMinute,
  );
  if (!rl.ok) {
    return reply.code(429).send({ error: "Read rate limit exceeded" });
  }

  const inFlight = await prisma.readJob.count({
    where: { caseId, status: "RUNNING" },
  });
  if (inFlight >= config.maxInFlightJobsPerCase) {
    return reply
      .code(429)
      .send({ error: "Too many jobs in flight for this case" });
  }

  const needed = caseRow.documents.filter((d) =>
    documentMatchesDegreeLevel(d, degreeLevel),
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

  const hash = inputHashFor(
    caseId,
    "EDUCATION",
    ready.map((d) => `${d.id}:${d.sha256}:${d.text?.length ?? 0}`).sort(),
    degreeLevel,
  );
  const jobId = buildJobId(caseId, "EDUCATION", hash, degreeLevel);

  const existing = await prisma.readJob.findUnique({ where: { id: jobId } });
  if (existing && existing.status === "DONE" && !existing.stale) {
    console.log(
      `[read] EDUCATION/${degreeLevel} case=${caseId} job=${jobId} CACHE HIT`,
    );
    return {
      jobId: existing.id,
      status: "DONE" as const,
      cached: true,
      degreeLevel,
      result: existing.resultJson,
    };
  }

  console.log(
    `[read] EDUCATION/${degreeLevel} case=${caseId} job=${jobId} starting…`,
  );

  await prisma.readJob.upsert({
    where: { id: jobId },
    create: {
      id: jobId,
      caseId,
      section: "EDUCATION",
      degreeLevel,
      inputHash: hash,
      status: "RUNNING",
      stale: false,
    },
    update: {
      status: "RUNNING",
      degreeLevel,
      error: null,
      stale: false,
      resultJson: undefined,
    },
  });

  try {
    const result = await parseEducation(caseId, degreeLevel);
    const resultJson = JSON.parse(JSON.stringify(result)) as object;

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
      degreeLevel,
      result: resultJson,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.readJob.update({
      where: { id: jobId },
      data: { status: "FAILED", error: message },
    });
    req.log.error({ err, jobId, degreeLevel }, "sync education read failed");
    return reply.code(502).send({
      jobId,
      status: "FAILED",
      degreeLevel,
      error: message,
    });
  }
}

async function runExperienceRead(
  req: { clientId: string; log: { error: (o: unknown, m: string) => void } },
  reply: {
    code: (n: number) => { send: (b: unknown) => unknown };
  },
  caseId: string,
) {
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

  const inFlight = await prisma.readJob.count({
    where: { caseId, status: "RUNNING" },
  });
  if (inFlight >= config.maxInFlightJobsPerCase) {
    return reply
      .code(429)
      .send({ error: "Too many jobs in flight for this case" });
  }

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

  const hash = inputHashFor(
    caseId,
    "EXPERIENCE",
    ready.map((d) => `${d.id}:${d.sha256}:${d.text?.length ?? 0}`).sort(),
  );
  const jobId = buildJobId(caseId, "EXPERIENCE", hash);

  const existing = await prisma.readJob.findUnique({ where: { id: jobId } });
  if (existing && existing.status === "DONE" && !existing.stale) {
    console.log(
      `[read] EXPERIENCE case=${caseId} job=${jobId} CACHE HIT — no Gemini call`,
    );
    return {
      jobId: existing.id,
      status: "DONE" as const,
      cached: true,
      result: existing.resultJson,
    };
  }

  console.log(
    `[read] EXPERIENCE case=${caseId} job=${jobId} starting sync Gemini parse…`,
  );

  await prisma.readJob.upsert({
    where: { id: jobId },
    create: {
      id: jobId,
      caseId,
      section: "EXPERIENCE",
      degreeLevel: null,
      inputHash: hash,
      status: "RUNNING",
      stale: false,
    },
    update: {
      status: "RUNNING",
      degreeLevel: null,
      error: null,
      stale: false,
      resultJson: undefined,
    },
  });

  try {
    const result = await parseExperience(caseId);
    const resultJson = JSON.parse(JSON.stringify(result)) as object;

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
    req.log.error({ err, jobId }, "sync experience read failed");
    return reply.code(502).send({
      jobId,
      status: "FAILED",
      error: message,
    });
  }
}

export const jobRoutes: FastifyPluginAsync = async (app) => {
  /** Per-level education read: POST /cases/:id/read/education/:degreeLevel */
  app.post("/cases/:id/read/education/:degreeLevel", async (req, reply) => {
    const { id: caseId, degreeLevel: raw } = req.params as {
      id: string;
      degreeLevel: string;
    };
    const degreeLevel = parseDegreeLevelParam(raw);
    if (!degreeLevel) {
      return reply.code(400).send({
        error:
          "degreeLevel must be diploma | advanced_diploma | bachelor | master | phd",
      });
    }
    return runEducationRead(req, reply, caseId, degreeLevel);
  });

  /**
   * Flat read routes (compat):
   * - /read/education → bachelor
   * - /read/experience → unchanged, no degreeLevel
   */
  app.post("/cases/:id/read/:section", async (req, reply) => {
    const { id: caseId, section: sectionRaw } = req.params as {
      id: string;
      section: string;
    };
    const section =
      sectionRaw.toUpperCase() === "EXPERIENCE" ? "EXPERIENCE" : "EDUCATION";

    if (section === "EXPERIENCE") {
      return runExperienceRead(req, reply, caseId);
    }
    return runEducationRead(req, reply, caseId, "bachelor");
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
      degreeLevel: job.degreeLevel,
      status: job.status,
      error: job.error,
      stale: job.stale,
      result: job.resultJson,
      updatedAt: job.updatedAt,
    };
  });
};
