/**
 * Client (applicant) name read from the CV or transcript text — shown on the
 * Clients page only, never in the engine steps.
 *
 * Stored on the existing FieldSource table as field "clientName" with
 * degreeLevel null (the slot the schema reserves for non-level fields), so no
 * schema change is needed. The engine's draft save only writes rows that have
 * a degreeLevel, and GET /cases/:id leaves this row out, so the wizard never
 * sees or overwrites it.
 */
import { prisma } from "./prisma.js";

export const CLIENT_NAME_FIELD = "clientName";

export type ClientNameSource = "cv_llm" | "cv_text" | "transcript_text";

/** LLM name beats text heuristics; CV text beats transcript text. */
const SOURCE_CONFIDENCE: Record<ClientNameSource, number> = {
  cv_llm: 0.9,
  cv_text: 0.6,
  transcript_text: 0.55,
};

/** Words that make a line a heading / label / role, not a person's name. */
const NOT_A_NAME =
  /\b(curriculum|vitae|vita|r[eé]sum[eé]s?|cv|bio[- ]?data|profile|personal|details?|information|contact|objective|summary|career|professional|experience|education|qualifications?|skills?|references?|declaration|address|phone|mobile|tel|email|e-mail|linkedin|nationality|date|birth|dob|gender|marital|status|page|engineer(?:ing)?|engineers|manager|supervisor|technician|technologist|consultant|officer|assistant|director|intern|student|graduate|university|college|institute|school|faculty|department|company|ltd|pvt|limited|inc|llc|street|road|st|rd|avenue|lane|city|district|province|state|nepal|india|australia|pakistan|bangladesh|sri\s+lanka|kathmandu|lalitpur|bhaktapur|pokhara|dubai|qatar|saudi|arabia|bachelor|master|diploma|degree|b\.?\s?tech|b\.?\s?e|m\.?\s?tech|phd|civil|mechanical|electrical|electronics|chemical|software|project|site|structural)\b/i;

/** "Mr." / "Er." etc. are dropped before the name check. */
const HONORIFIC = /^(?:mr|mrs|ms|miss|dr|er|eng|engr|prof)\.?\s+/i;

function titleCase(word: string): string {
  return word
    .split(/([-'])/)
    .map((p) => (/^[-']$/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()))
    .join("");
}

/**
 * Sanity check: a person-like name (2–5 words of letters), not a heading such
 * as "Curriculum Vitae" / "Resume", a job title, place or contact line.
 * Returns the cleaned name or null.
 */
export function sanitizeClientName(raw: string | null | undefined): string | null {
  let s = (raw ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  if (!s) return null;
  s = s.replace(/^(?:full\s+)?name\s*[:\-–—]\s*/i, "").trim();
  for (let i = 0; i < 2; i++) s = s.replace(HONORIFIC, "").trim();
  s = s.replace(/[\s,.;:|\-–—]+$/, "").trim();
  if (s.length < 3 || s.length > 60) return null;
  if (/[\d@/\\|:;,()[\]{}<>#&+=_*"!?]/.test(s)) return null;
  if (NOT_A_NAME.test(s)) return null;
  const words = s.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 5) return null;
  // Each word: letters (any script), optionally with ' - . inside (e.g. "D'Souza", "K.").
  if (!words.every((w) => /^\p{L}[\p{L}\p{M}'\.\-]*$/u.test(w))) return null;
  // At least two words of 2+ letters, so "J. K." alone does not pass.
  if (words.filter((w) => w.replace(/[^\p{L}]/gu, "").length >= 2).length < 2) return null;
  const allCaps = s === s.toUpperCase();
  const allLower = s === s.toLowerCase();
  return allCaps || allLower ? words.map(titleCase).join(" ") : words.join(" ");
}

/**
 * No-LLM name guess from CV text: a "Name: …" line anywhere near the top,
 * otherwise the first person-like line among the first few lines.
 */
export function clientNameFromCvText(text: string | null | undefined): string | null {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 40);
  for (const line of lines) {
    const m = line.match(/^(?:full\s+)?name\s*[:\-–—]\s*(.+)$/i);
    if (m) {
      const hit = sanitizeClientName(m[1]);
      if (hit) return hit;
    }
  }
  for (const line of lines.slice(0, 6)) {
    const hit = sanitizeClientName(line);
    if (hit) return hit;
  }
  return null;
}

/**
 * Explicit person-name labels common on transcripts / certificates.
 * Captures the value after the label; "Name of Institution" etc. are excluded.
 */
const TRANSCRIPT_NAME_LABEL =
  /^(?:student(?:['’]?s)?\s+name|name\s+of\s+(?:the\s+)?student|candidate(?:['’]?s)?\s+name|name\s+of\s+(?:the\s+)?candidate|learner(?:['’]?s)?\s+name|name\s+of\s+(?:the\s+)?learner|full\s+name|name\s+of\s+(?:the\s+)?(?:candidate\s*\/?\s*student|student\s*\/?\s*candidate)|(?:student|candidate|learner)\s*\/\s*(?:candidate|student|learner)?\s*name)\s*[:.\-–—]?\s*(.*)$/i;

/** Plain "Name:" on a transcript header — not "Name of Programme/Institution/…". */
const PLAIN_NAME_LABEL =
  /^(?:full\s+)?name\s*[:\-–—]\s*(.+)$/i;
const NAME_OF_NON_PERSON =
  /^name\s+of\s+(?:the\s+)?(?:institution|programme|program|course|award|qualification|school|college|university|polytechnic|faculty|department|exam(?:ination)?|board|centre|center)\b/i;

/**
 * No-LLM name guess from transcript / certificate OCR text. Prefers an
 * explicit student/candidate/learner label; never treats a degree title or
 * institution header as a name.
 */
export function clientNameFromTranscriptText(text: string | null | undefined): string | null {
  const raw = (text ?? "").slice(0, 8000);
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 120);

  for (const line of lines) {
    if (NAME_OF_NON_PERSON.test(line)) continue;
    const labeled = line.match(TRANSCRIPT_NAME_LABEL);
    if (labeled) {
      const hit = sanitizeClientName(labeled[1] || "");
      if (hit) return hit;
      continue;
    }
    const plain = line.match(PLAIN_NAME_LABEL);
    if (plain) {
      const hit = sanitizeClientName(plain[1]);
      if (hit) return hit;
    }
  }

  // No bare first-line guess: transcript tops are usually institution / title.
  return null;
}

type StoredName = {
  id: string;
  finalValue: string | null;
  confidence: number | null;
  sourceDocumentId: string | null;
  alternatives: unknown;
};

function sourceOf(stored: StoredName | null): ClientNameSource | null {
  if (!stored) return null;
  const alt = stored.alternatives;
  if (alt && typeof alt === "object" && !Array.isArray(alt)) {
    const s = (alt as { source?: unknown }).source;
    if (s === "cv_llm" || s === "cv_text" || s === "transcript_text") return s;
  }
  if ((stored.confidence ?? 0) >= 0.9) return "cv_llm";
  if ((stored.confidence ?? 0) >= 0.6) return "cv_text";
  if ((stored.confidence ?? 0) >= 0.55) return "transcript_text";
  return null;
}

async function loadStored(caseId: string): Promise<StoredName | null> {
  return prisma.fieldSource.findFirst({
    where: { caseId, field: CLIENT_NAME_FIELD, degreeLevel: null },
    orderBy: { id: "asc" },
    select: {
      id: true,
      finalValue: true,
      confidence: true,
      sourceDocumentId: true,
      alternatives: true,
    },
  });
}

/**
 * Save the client name on the case. Never lets a weaker source overwrite a
 * stronger one; a different (newer) document at equal-or-higher confidence
 * replaces an older name. Best effort: never throws.
 */
export async function saveClientName(
  caseId: string,
  documentId: string | null,
  name: string | null,
  source: ClientNameSource,
): Promise<boolean> {
  const clean = sanitizeClientName(name);
  if (!clean) return false;
  const confidence = SOURCE_CONFIDENCE[source];
  try {
    const stored = await loadStored(caseId);
    const data = {
      sourceDocumentId: documentId,
      extractedValue: clean,
      finalValue: clean,
      confidence,
      alternatives: { source },
    };
    if (!stored) {
      await prisma.fieldSource.create({
        data: { caseId, field: CLIENT_NAME_FIELD, degreeLevel: null, ...data },
      });
      return true;
    }
    const sameDoc = stored.sourceDocumentId === documentId;
    if (sameDoc && (stored.confidence ?? 0) > confidence) return false;
    // Across documents: weaker never overwrites stronger (stops transcript
    // from replacing a CV name; a new CV at higher/equal confidence still wins).
    if (!sameDoc && (stored.confidence ?? 0) > confidence) return false;
    if (sameDoc && stored.finalValue === clean && stored.confidence === confidence) return false;
    await prisma.fieldSource.update({ where: { id: stored.id }, data });
    return true;
  } catch (err) {
    console.warn(
      `[client-name] save failed for case=${caseId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Fill the Clients-page name from CV text, then from finished transcript /
 * certificate OCR text, only when a stronger name is not already stored.
 * Used after OCR, on a cached Step 2 read and on assess, so existing cases
 * pick a name up without re-extraction / migration.
 */
export async function ensureClientNameFromDocuments(caseId: string): Promise<void> {
  try {
    const cv = await prisma.document.findFirst({
      where: { caseId, type: "CV", status: "DONE", text: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, text: true },
    });
    const stored = await loadStored(caseId);
    const src = sourceOf(stored);

    // Strong CV name for the current CV already present — leave it.
    if (
      cv &&
      stored?.finalValue &&
      stored.sourceDocumentId === cv.id &&
      (src === "cv_llm" || src === "cv_text")
    ) {
      return;
    }

    if (cv?.text?.trim()) {
      const guess = clientNameFromCvText(cv.text);
      if (guess) {
        await saveClientName(caseId, cv.id, guess, "cv_text");
        return;
      }
    }

    // Keep an existing CV-sourced name even if the CV text heuristic failed
    // this pass (e.g. cv_llm from experience parse).
    if (stored?.finalValue && (src === "cv_llm" || src === "cv_text")) return;

    // Already have a transcript name — leave it.
    if (stored?.finalValue && src === "transcript_text") return;

    const docs = await prisma.document.findMany({
      where: {
        caseId,
        type: { in: ["TRANSCRIPT", "CERTIFICATE"] },
        status: "DONE",
        text: { not: null },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, text: true },
    });
    for (const doc of docs) {
      if (!doc.text?.trim()) continue;
      const guess = clientNameFromTranscriptText(doc.text);
      if (guess) {
        await saveClientName(caseId, doc.id, guess, "transcript_text");
        return;
      }
    }
  } catch (err) {
    console.warn(
      `[client-name] fill failed for case=${caseId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** @deprecated Prefer ensureClientNameFromDocuments; kept as a stable alias. */
export async function ensureClientNameFromCv(caseId: string): Promise<void> {
  return ensureClientNameFromDocuments(caseId);
}
