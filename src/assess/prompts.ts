export function subjectExtractSystemPrompt(): string {
  return `You extract academic subject / unit / course NAMES from university transcript plain text.

The response MUST be a single JSON object matching this exact schema (no markdown, no extra keys):
{
  "subjects": [
    { "name": string }
  ]
}

Rules:
- Output ONLY the subject / unit / course title in "name". Do NOT extract unit codes, credit hours, grades, marks, semesters, years, or degree level (bachelor/master).
- Extract EVERY distinct subject name that appears in this text chunk. Do not invent or rename subjects.
- Keep each name exactly as written on the transcript (minor whitespace cleanup only).
- Include projects, theses, capstones, internships / industrial training when they appear as named entries.
- Ignore GPA, totals, grading scales, headers, footers, signatures, university details, and table columns that are not the subject title.
- This text may be only ONE PART of a longer transcript — extract names from this part only; do not assume missing pages.
- If the same subject name appears twice in this chunk, include it once.
- If none found: {"subjects": []}.`;
}

export function subjectExtractUserPrompt(chunk: string): string {
  return `Extract subject names only from this transcript text.
---
${chunk}
---`;
}

export function unclearMatchSystemPrompt(): string {
  return `You match transcript subject names to a fixed Chemical Engineer (ANZSCO 233111) rubric subject list.

Return JSON only:
{
  "decisions": [
    {
      "transcriptName": string,
      "matchedSubject": string|null,
      "match": "yes" | "partial" | "no",
      "confidence": number,
      "reason": string
    }
  ]
}

Rules:
- matchedSubject MUST be exactly one of the provided rubric subject names, or null.
- "yes" = clearly the same knowledge area; "partial" = related but incomplete; "no" = not a match.
- Do not invent rubric subjects. Prefer "no" when unsure.
- One short reason (≤20 words).`;
}

export function unclearMatchUserPrompt(
  unclear: string[],
  rubricNames: Array<{ name: string; variants: string[] }>,
): string {
  return `Rubric subjects (name + example variants):
${rubricNames
  .map((r) => `- ${r.name}: ${(r.variants ?? []).slice(0, 8).join("; ")}`)
  .join("\n")}

Transcript subjects to classify:
${unclear.map((n, i) => `${i + 1}. ${n}`).join("\n")}

Return one decision per transcript subject.`;
}

export function workExperienceSystemPrompt(): string {
  return `Decide whether the candidate's work experience is related to Chemical Engineering (ANZSCO 233111).

Return JSON only:
{
  "related": boolean,
  "confidence": number,
  "reason": string
}

Related means process/plant chemical engineering work (process design, reaction engineering, heat/mass transfer operations, petrochemical, pharmaceuticals process, etc.).
Generic "engineer" titles without chemical/process content are NOT related.
Be conservative.`;
}

export function workExperienceUserPrompt(
  experienceSummary: string,
  cvSnippet: string | null,
): string {
  return `Experience rows:
${experienceSummary || "(none)"}

CV snippet (optional):
${cvSnippet ? cvSnippet.slice(0, 4000) : "(none)"}`;
}

export function explanationSystemPrompt(): string {
  return `Write a short assessor-facing explanation (2–4 sentences) for an ANZSCO 233111 Chemical Engineer academic assessment.
Use ONLY the computed numbers and outcomes provided. Do not invent subjects or change the determination.
Return JSON: { "explanation": string }`;
}

export function explanationUserPrompt(payload: Record<string, unknown>): string {
  return `Computed assessment:
${JSON.stringify(payload, null, 2)}`;
}
