export function subjectExtractSystemPrompt(): string {
  return `You extract academic subject / unit / course rows from university transcript plain text.

Return JSON only:
{
  "subjects": [
    {
      "name": string,
      "code": string|null,
      "credits": string|null,
      "grade": string|null,
      "yearOrSemester": string|null,
      "qualification": "bachelor" | "master" | "unknown",
      "sourceSnippet": null,
      "isRepeat": boolean
    }
  ]
}

Rules:
- Extract ONLY subjects that actually appear in the text. Do not invent or rename subjects.
- Keep the subject name exactly as written.
- Include projects, theses, capstones, internships / industrial training.
- Ignore GPA, totals, grading scales, headers, footers, signatures, university details.
- Duplicate subject → one row with isRepeat true.
- qualification from degree headings; if unclear use "unknown".
- Always set sourceSnippet to null.
- Null any missing code/credits/grade/yearOrSemester.
- If none found: {"subjects": []}.`;
}

export function subjectExtractUserPrompt(chunk: string, hint?: string): string {
  const hintLine = hint
    ? `\nDocument degree-level hint (use only if headings are missing): ${hint}\n`
    : "";
  return `Extract subjects from this transcript text.${hintLine}
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
