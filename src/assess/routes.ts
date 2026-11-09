import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { assessCase, checkOccupationForCase } from "../assess/assessCase.js";
import { prisma } from "../lib/prisma.js";
import { emAnswersSchema } from "./engineeringManager.js";
import { engineeringManagerForCase, saveEngineeringManagerAnswers } from "./engineeringManagerStore.js";
import {
  EM_CHECK_ONLY,
  isEngineeringManager,
  listManualOccupationOptions,
  NoSavedSubjectsError,
  resolveManualOccupation,
  saveManualSelection,
  TelecomNeedsIct60220Error,
} from "./manualOccupation.js";
import { isTelecomAnzsco } from "./telecomGroup.js";
import { getTranscriptData, saveTranscriptOverrides } from "./transcriptData.js";
import {
  answerLateralEntry,
  recordLateralDecision,
  ensurePriorStudySubjects,
  PriorStudyNotReadyError,
  readPriorStudySubjects,
} from "./lateralEntryStore.js";

const lateralAnswerBody = z.object({
  question: z.enum(["answer", "confirm"]),
  answer: z.enum(["yes", "no"]),
});

const assessBody = z.object({
  force: z.boolean().optional(),
});

/**
 * Assessment step run. Always scores the saved subjects (never re-extracts:
 * re-reading transcripts is the Transcript data step). A lateral-entry
 * prior-study transcript with no subjects yet is read first. `rescore` skips the
 * cached result; legacy `force` means the same here.
 */
const assessRunBody = z.object({
  rescore: z.boolean().optional(),
  force: z.boolean().optional(),
  /** Manual review: occupation id or ANZSCO code to score; null clears it. */
  manualOccupation: z.string().trim().max(120).nullable().optional(),
});

/** Assessor check of one ANZSCO (read-only). */
const checkOccupationBody = z.object({
  occupation: z.string().trim().min(1).max(120),
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
  // Occupations the assessor can pick for a manual-review case.
  app.get("/assess/occupations", async () => listManualOccupationOptions());

  app.post("/cases/:id/assess", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = assessRunBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request" });
    const body = parsed.data;

    const existing = await prisma.case.findFirst({
      where: { id, clientId: req.clientId },
    });
    if (!existing) return reply.code(404).send({ error: "Case not found" });

    if (body.manualOccupation !== undefined) {
      if (body.manualOccupation === null || body.manualOccupation === "") {
        await saveManualSelection(id, null);
      } else {
        const resolved = resolveManualOccupation(body.manualOccupation);
        if (!resolved.ok) return reply.code(400).send({ error: resolved.error });
        if (isEngineeringManager(resolved.selection.occupationId)) {
          return reply.code(400).send({ error: EM_CHECK_ONLY });
        }
        if (isTelecomAnzsco(resolved.selection.occupationId)) {
          // Telecom group matching needs ICT60220: stop before saving the choice.
          try {
            await checkOccupationForCase(id, resolved.selection.occupationId);
          } catch (err) {
            if (err instanceof TelecomNeedsIct60220Error) {
              return reply.code(422).send({ error: err.message });
            }
          }
        }
        await saveManualSelection(id, resolved.selection);
      }
    }

    // Lateral entry: a prior-study transcript without subjects is read now
    // (only that file; the bachelor's own transcripts are never re-read here).
    await ensurePriorStudySubjects(id);

    try {
      const result = await assessCase(id, {
        subjectsOnly: true,
        rescore: Boolean(body.rescore || body.force || body.manualOccupation !== undefined),
      });
      return result;
    } catch (err) {
      if (err instanceof NoSavedSubjectsError) {
        return reply.code(409).send({ error: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, "assess failed");
      return reply.code(500).send({ error: message });
    }
  });

  // Assessor check of any ANZSCO on the saved subjects. Read-only: nothing is
  // saved, and the assessment result, manual selection and case are untouched.
  app.post("/cases/:id/assess/check", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = checkOccupationBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request" });
    const existing = await prisma.case.findFirst({ where: { id, clientId: req.clientId } });
    if (!existing) return reply.code(404).send({ error: "Case not found" });
    const resolved = resolveManualOccupation(parsed.data.occupation);
    if (!resolved.ok) return reply.code(400).send({ error: resolved.error });
    if (isEngineeringManager(resolved.selection.occupationId)) {
      return reply.code(400).send({ error: EM_CHECK_ONLY });
    }
    try {
      const check = await checkOccupationForCase(id, resolved.selection.occupationId);
      if (!check) {
        return reply.code(422).send({ error: "Matching is not available for this occupation." });
      }
      return check;
    } catch (err) {
      if (err instanceof NoSavedSubjectsError) {
        return reply.code(409).send({ error: err.message });
      }
      if (err instanceof TelecomNeedsIct60220Error) {
        return reply.code(422).send({ error: err.message });
      }
      req.log.error({ err }, "occupation check failed");
      return reply.code(500).send({ error: "Could not check this occupation" });
    }
  });

  // Engineering Manager (133211) check: CV jobs + assessor answers (Check an ANZSCO only).
  app.get("/cases/:id/assess/engineering-manager", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.case.findFirst({ where: { id, clientId: req.clientId } });
    if (!existing) return reply.code(404).send({ error: "Case not found" });
    try {
      return await engineeringManagerForCase(id);
    } catch (err) {
      req.log.error({ err }, "engineering manager check failed");
      return reply.code(500).send({ error: "Could not check Engineering Manager" });
    }
  });

  // Save the assessor answers (one FieldSource row) and return the check.
  app.put("/cases/:id/assess/engineering-manager", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = emAnswersSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid answers" });
    const existing = await prisma.case.findFirst({ where: { id, clientId: req.clientId } });
    if (!existing) return reply.code(404).send({ error: "Case not found" });
    try {
      await saveEngineeringManagerAnswers(id, parsed.data);
      return await engineeringManagerForCase(id, parsed.data);
    } catch (err) {
      req.log.error({ err }, "engineering manager save failed");
      return reply.code(500).send({ error: "Could not save the Engineering Manager answers" });
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
      const data = await getTranscriptData(id, { mode: "extract", force: body.force });
      if (data) await recordLateralDecision(id, data.lateralEntry, "decision");
      return data;
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

  // Lateral entry (Verify details): answer the question / re-confirmation.
  app.put("/cases/:id/lateral-entry", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = lateralAnswerBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid answer" });
    const existing = await prisma.case.findFirst({ where: { id, clientId: req.clientId } });
    if (!existing) return reply.code(404).send({ error: "Case not found" });
    await answerLateralEntry(id, parsed.data.question, parsed.data.answer);
    const data = await getTranscriptData(id, { mode: "read" });
    if (data) await recordLateralDecision(id, data.lateralEntry, "decision");
    return data;
  });

  // Lateral entry Route 3: read the earlier study's subjects from its transcript.
  app.post("/cases/:id/lateral-entry/prior-subjects", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.case.findFirst({ where: { id, clientId: req.clientId } });
    if (!existing) return reply.code(404).send({ error: "Case not found" });
    try {
      await readPriorStudySubjects(id);
    } catch (err) {
      if (err instanceof PriorStudyNotReadyError) {
        return reply.code(409).send({ error: err.message });
      }
      req.log.error({ err }, "prior study read failed");
      return reply.code(500).send({ error: "Could not read the earlier study's subjects" });
    }
    const data = await getTranscriptData(id, { mode: "read" });
    if (data) await recordLateralDecision(id, data.lateralEntry, "decision");
    return data;
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
