/**
 * Pure helpers for the Clients list (GET /clients). Everything is derived from
 * data the wizard already stores — no new columns.
 */

export type ClientVerification = "approved" | "rejected" | "unverified";
export type ClientFilter = "all" | ClientVerification;

const DEGREE_RANK: Record<string, number> = {
  phd: 5,
  master: 4,
  bachelor: 3,
  advanced_diploma: 2,
  diploma: 1,
};

export const DEGREE_LEVEL_LABEL: Record<string, string> = {
  phd: "PhD",
  master: "Master's",
  bachelor: "Bachelor's",
  advanced_diploma: "Advanced Diploma",
  diploma: "Diploma",
};

/**
 * Step 6 decision → list status. Unverified = neither approved nor rejected
 * (no saved decision).
 */
export function verificationOf(
  reviewStatus: string | null | undefined,
): ClientVerification {
  if (reviewStatus === "APPROVED") return "approved";
  if (reviewStatus === "REJECTED") return "rejected";
  return "unverified";
}

/**
 * Best-effort client name from an uploaded file name, e.g.
 * "7. Rahna - cv.docx" → "Rahna", "Shobit Razdan RESUME 25052026.docx" → "Shobit Razdan".
 */
export function nameFromFileName(fileName: string | null | undefined): string | null {
  let name = (fileName ?? "").trim();
  if (!name) return null;
  name = name
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[_+]+/g, " ")
    .replace(/^\s*\d+\s*[.)-]\s*/, "")
    .replace(/\(\d+\)/g, " ")
    .replace(/\b(curriculum\s+vitae|r[eé]sum[eé]|cv|transcripts?|official|verification)(?![\p{L}\d])/giu, " ")
    .replace(/\b\d{4,}\b/g, " ")
    .replace(/\s*[-–—]\s*$/g, "")
    .replace(/^\s*[-–—]\s*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/[\s\-–—,.]+$/, "")
    .trim();
  return name || null;
}

export type ClientNameSource = "cv_text" | "cv_file" | "document_file" | "case_id";

/**
 * Clients page name: the name read from the CV text first, then the old
 * file-name guess (CV file, then the first document), then the case id.
 */
export function resolveClientName(input: {
  caseId: string;
  cvTextName?: string | null;
  cvFileName?: string | null;
  firstFileName?: string | null;
}): { name: string; source: ClientNameSource } {
  const fromText = (input.cvTextName ?? "").trim();
  if (fromText) return { name: fromText, source: "cv_text" };
  const fromCv = nameFromFileName(input.cvFileName);
  if (fromCv) return { name: fromCv, source: "cv_file" };
  const fromOther = nameFromFileName(input.firstFileName);
  if (fromOther) return { name: fromOther, source: "document_file" };
  return { name: `Client ${input.caseId.slice(-6)}`, source: "case_id" };
}

export type OccupationInfo = { anzscoCode: string | null; title: string | null };

/** "Chemical Engineer (233111)" → { title, anzscoCode }. */
export function parseOccupationLabel(label: string | null | undefined): OccupationInfo | null {
  const text = (label ?? "").trim();
  if (!text) return null;
  const m = text.match(/^(.*?)\s*\((\d{4,6})\)\s*$/);
  if (m) return { title: m[1]!.trim() || null, anzscoCode: m[2]! };
  return { title: text, anzscoCode: null };
}

/**
 * Selected occupation: the stored Step 4 risk result first (what the user chose),
 * then the case's target occupation label, then the top Step 3 recommendation.
 */
export function resolveOccupation(input: {
  riskCode?: string | null;
  riskTitle?: string | null;
  targetOccupation?: string | null;
  assessmentCode?: string | null;
  assessmentTitle?: string | null;
}): OccupationInfo {
  if (input.riskCode || input.riskTitle) {
    return { anzscoCode: input.riskCode || null, title: input.riskTitle || null };
  }
  const fromLabel = parseOccupationLabel(input.targetOccupation);
  if (fromLabel) return fromLabel;
  return {
    anzscoCode: input.assessmentCode || null,
    title: input.assessmentTitle || null,
  };
}

export type DegreeInfo = {
  degreeLevel: string | null;
  degreeLabel: string | null;
  degreeTitle: string | null;
  institution: string | null;
};

/** Highest qualification (PhD → Diploma); falls back to the highest selected level. */
export function highestDegree(
  qualifications: Array<{
    degreeLevel: string;
    degreeTitle: string | null;
    institution: string | null;
  }>,
  selectedLevels: string[] = [],
): DegreeInfo {
  const rank = (level: string) => DEGREE_RANK[level] ?? 0;
  const withTitle = qualifications
    .filter((q) => (q.degreeTitle ?? "").trim())
    .sort((a, b) => rank(b.degreeLevel) - rank(a.degreeLevel));
  const best = withTitle[0];
  if (best) {
    return {
      degreeLevel: best.degreeLevel,
      degreeLabel: DEGREE_LEVEL_LABEL[best.degreeLevel] ?? best.degreeLevel,
      degreeTitle: best.degreeTitle!.trim(),
      institution: (best.institution ?? "").trim() || null,
    };
  }
  const level = [...selectedLevels].sort((a, b) => rank(b) - rank(a))[0];
  return {
    degreeLevel: level ?? null,
    degreeLabel: level ? (DEGREE_LEVEL_LABEL[level] ?? level) : null,
    degreeTitle: null,
    institution: null,
  };
}

export function snippet(text: string | null | undefined, max = 140): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
