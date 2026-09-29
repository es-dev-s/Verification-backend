import type { FastifyPluginAsync } from "fastify";
import { DocumentType } from "@prisma/client";
import { config } from "../config.js";
import { deleteBlob, sha256, storeBlob } from "../lib/blob.js";
import { detectFormatFromBytes } from "../lib/formats.js";
import { prisma } from "../lib/prisma.js";
import { getExtractQueue } from "../lib/queues.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { markReadsStale } from "../workers/extract.js";

export const documentRoutes: FastifyPluginAsync = async (app) => {
  app.post("/cases/:id/documents", async (req, reply) => {
    const { id: caseId } = req.params as { id: string };
    const caseRow = await prisma.case.findFirst({
      where: { id: caseId, clientId: req.clientId },
    });
    if (!caseRow) return reply.code(404).send({ error: "Case not found" });

    const rl = await checkRateLimit(
      `upload:${req.clientId}`,
      config.uploadsPerMinute,
    );
    if (!rl.ok) {
      return reply.code(429).send({ error: "Upload rate limit exceeded" });
    }

    const inFlight = await prisma.document.count({
      where: {
        caseId,
        status: { in: ["QUEUED", "EXTRACTING"] },
      },
    });
    if (inFlight >= config.maxInFlightJobsPerCase) {
      return reply
        .code(429)
        .send({ error: "Too many jobs in flight for this case" });
    }

    const queryType = String(
      (req.query as { type?: string }).type ?? "",
    ).toUpperCase();

    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: "No file uploaded" });
    }

    const fields = file.fields as Record<
      string,
      { value?: string } | Array<{ value?: string }> | undefined
    >;
    const fieldTypeRaw = (() => {
      const t = fields.type ?? fields.documentType;
      if (!t) return "";
      if (Array.isArray(t)) return String(t[0]?.value ?? "");
      return String(t.value ?? "");
    })();
    const typeRaw = (queryType || fieldTypeRaw).toUpperCase();
    if (!["CV", "TRANSCRIPT", "CERTIFICATE"].includes(typeRaw)) {
      return reply
        .code(400)
        .send({ error: "type must be CV, Transcript, or Certificate" });
    }
    const type = typeRaw as DocumentType;

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
    if (!bytes.length) {
      return reply.code(400).send({ error: "Empty file" });
    }

    const format = detectFormatFromBytes(bytes);
    if (!format) {
      return reply.code(400).send({
        error:
          "Unrecognized file content. Accepted formats: PDF, PNG, JPG, DOCX (validated by magic bytes, not extension)",
      });
    }

    const hash = sha256(bytes);

    // Keep only the latest file per type on a case — remove prior CV/Transcript/Certificate.
    const previous = await prisma.document.findMany({
      where: { caseId, type },
      select: { id: true },
    });
    if (previous.length) {
      const ids = previous.map((d) => d.id);
      await prisma.document.deleteMany({ where: { id: { in: ids } } });
      await Promise.all(ids.map((id) => deleteBlob(id).catch(() => undefined)));
    }

    const doc = await prisma.document.create({
      data: {
        caseId,
        type,
        originalName: file.filename || `upload.${format.toLowerCase()}`,
        format,
        sha256: hash,
        status: "QUEUED",
      },
    });

    await storeBlob(doc.id, bytes);
    await markReadsStale(caseId);
    await getExtractQueue().add(
      "extract",
      { documentId: doc.id },
      { jobId: doc.id },
    );

    return reply.code(201).send({ documentId: doc.id, document: doc });
  });

  app.delete("/cases/:id/documents/:docId", async (req, reply) => {
    const { id: caseId, docId } = req.params as {
      id: string;
      docId: string;
    };
    const caseRow = await prisma.case.findFirst({
      where: { id: caseId, clientId: req.clientId },
    });
    if (!caseRow) return reply.code(404).send({ error: "Case not found" });

    const doc = await prisma.document.findFirst({
      where: { id: docId, caseId },
    });
    if (!doc) return reply.code(404).send({ error: "Document not found" });

    await prisma.document.delete({ where: { id: docId } });
    await markReadsStale(caseId);
    return { ok: true };
  });
};
