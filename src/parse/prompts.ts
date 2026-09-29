import type { DocumentTypeLabel } from "./schemas.js";

export function educationMultiSystemPrompt(): string {
  return `You extract bachelor's-degree education fields from one or more labeled documents' plain text.

You will receive several sources, each tagged with documentId and documentType (CV, TRANSCRIPT, or CERTIFICATE).
Extract fields SEPARATELY for each source. Do not merge across sources — the server merges by priority.

Return JSON only matching this schema exactly:
{
  "sources": [
    {
      "documentId": string,
      "documentType": "CV" | "TRANSCRIPT" | "CERTIFICATE",
      "degreeTitle": string|null,
      "institution": string|null,
      "country": string|null,
      "start": string|null,
      "end": string|null,
      "statedDuration": string|null,
      "multipleBachelors": boolean,
      "confidence": {
        "degreeTitle": number|null,
        "institution": number|null,
        "country": number|null,
        "start": number|null,
        "end": number|null,
        "statedDuration": number|null
      }
    }
  ]
}

Per-source hints:
- CERTIFICATE: Prefer awarded bachelor's title and issuing institution as printed.
- TRANSCRIPT: Prefer program name, institution, and enrollment/session years near the header.
- CV: Education may be brief; prefer the bachelor's line if present.

Program duration (critical):
- Near the degree/program title header, look for SESSION YYYY-YYYY, BATCH YYYY-YYYY, or YYYY-YYYY / YYYY – YYYY.
  Put the first year in start and the second in end (e.g. SESSION 2019-2023 → start "2019", end "2023").
- Do NOT use dates near "Result Declaration Date", "Date of Issue", "Certified on", "Issued on",
  signatures, seals, or footer/stamp blocks — those are administrative dates, not program duration.
- If an explicit duration in years is stated (e.g. "4 years") AND a session range exists,
  put the years phrase in statedDuration and still fill start/end from the session range when present.
  Prefer statedDuration when both exist for the final duration signal.
- Prefer enrollment/graduation years over single day-month-year stamps.

Examples:

Example A — transcript header (correct):
Text:
  B.Sc Civil Engineering Technology
  Government College University Faisalabad
  SESSION 2019-2023
  ...
  RESULT DECLARATION DATE: 16-AUG-23
  (signature)
Expected for that source:
  degreeTitle ≈ "B.Sc Civil Engineering Technology"
  institution ≈ "Government College University Faisalabad"
  start = "2019"
  end = "2023"
  statedDuration = null (unless "4 years" is also written)
  Do NOT use 16-AUG-23 as end.

Example B — ignore issue date:
Text:
  Bachelor of Arts
  University of Example
  Date of Issue: 05-Jan-2024
Expected:
  start = null, end = null unless a SESSION/BATCH/YYYY-YYYY enrollment range appears elsewhere near the program title.

Example C — packed transcript header:
Text:
  Government College University
  Faisalabad, Pakistan
  ...
  B. Sc Civil Engineering Technology   (may appear on a verification/CV form, not always on the transcript body)
Expected when present:
  institution ≈ "Government College University Faisalabad" (or as printed)
  country = "Pakistan"
  degreeTitle from the bachelor line when printed; null if the transcript never names the award.

Example D — CV education block:
Text:
  EDUCATION
  Bachelor of Engineering (Hons.), Civil Engineering
  A.P.J. Abdul Kalam Technological University, India
  Aug 2018 – Aug 2022
Expected:
  degreeTitle ≈ "Bachelor of Engineering (Hons.), Civil Engineering"
  institution ≈ "A.P.J. Abdul Kalam Technological University"
  country = "India"
  start = "2018", end = "2022"
  Do NOT take "UK" from a profile sentence about UK consultancy work.

Example E — ignore non-bachelor awards:
Text:
  Qualification: ICT60220 Advanced Diploma of Information Technology
Expected:
  degreeTitle = null (Advanced Diploma is not a bachelor's). Still extract institution/country if printed.

Rules:
- Include one entry in "sources" for every documentId provided in the user message (even if all fields are null).
- Echo documentId and documentType exactly as given.
- Target the Bachelor's degree only. Ignore Diploma, Advanced Diploma, Master's, PhD, short courses unless clearly the bachelor award.
- If several bachelor's degrees appear in one source, take the first and set multipleBachelors to true.
- Every value is nullable. Never guess, invent, or normalize institution/degree wording — copy as written (after OCR cleanup already applied).
- Never leave truncated titles (e.g. cut off mid-word or with an unclosed parenthesis like "(Pow"). Prefer the longest complete phrase that appears in the text; if the source is cut off, stop at the last complete word and omit dangling "(".
- Do not include curly braces {}, JSON artifacts, or markdown in any field.
- country only if that source states a country near the education/institution header (or address on the award). Do NOT pull a country from work-experience locations or profile marketing text.
- Prefer the university named in the letterhead / first lines of a transcript over phrases like "Name of the College" or "seal of the University".
- statedDuration is an explicit duration phrase if present (e.g. "3 years", "6 semesters"); otherwise null. Do not treat course labels like "1YEAR" as statedDuration.
- start/end keep enrollment/graduation years or dates as written (prefer year-only from SESSION/BATCH/Year of Admission/Date of Entry). Prefer Date of Graduation / "completed ... on YYYY" over Result Declaration / Date of Issue.
- confidence is 0.0–1.0 when a value is set; null when value is null.`;
}

/** @deprecated Prefer educationMultiSystemPrompt — kept for reference. */
export function educationSystemPrompt(docType: DocumentTypeLabel): string {
  const typeHints: Record<DocumentTypeLabel, string> = {
    CERTIFICATE:
      "This is a degree certificate or diploma. Prefer the awarded bachelor's title and issuing institution as printed on the certificate.",
    TRANSCRIPT:
      "This is an academic transcript. Prefer program name, institution, and SESSION/BATCH year ranges near the header. Ignore Result Declaration / Date of Issue stamps.",
    CV: "This is a CV/resume. Education entries may be brief. Prefer the bachelor's degree line if present. Do not invent details.",
  };

  return `You extract bachelor's-degree education fields from one document's plain text.
${typeHints[docType]}

Return JSON only matching this schema exactly:
{
  "degreeTitle": string|null,
  "institution": string|null,
  "country": string|null,
  "start": string|null,
  "end": string|null,
  "statedDuration": string|null,
  "multipleBachelors": boolean,
  "confidence": {
    "degreeTitle": number|null,
    "institution": number|null,
    "country": number|null,
    "start": number|null,
    "end": number|null,
    "statedDuration": number|null
  }
}

Rules:
- Target the Bachelor's degree only. Ignore Diploma, Master's, PhD, certificates of short courses unless they are clearly the bachelor award.
- If several bachelor's degrees appear, take the first and set multipleBachelors to true.
- Every value is nullable. Never guess, invent, or normalize institution/degree wording — copy as written.
- country only if the document states a country (address, header, seal text). Otherwise null.
- statedDuration is an explicit duration phrase if present (e.g. "3 years", "6 semesters"); otherwise null.
- From SESSION/BATCH YYYY-YYYY near the program title, set start/end to those years. Never use Result Declaration / Date of Issue dates as start/end.
- start/end keep dates as written.
- confidence is 0.0–1.0 when a value is set; null when value is null.`;
}

export function experienceSystemPrompt(): string {
  return `You extract work experience rows from a CV/resume plain text.

Return JSON only matching this schema exactly:
{
  "rows": [
    {
      "employer": string|null,
      "title": string|null,
      "start": string|null,
      "end": string|null,
      "statedDurationYears": number|null,
      "domainMatch": null,
      "confidence": {
        "employer": number|null,
        "title": number|null,
        "start": number|null,
        "end": number|null,
        "statedDurationYears": number|null
      }
    }
  ]
}

Common CV layouts (extract all that match):
- "Title | Employer | Mon YYYY – Present" on one line
- "Title    Mon YYYY – Present" then employer on the next line
- "Employer    MON YYYY TO PRESENT" then title on the next line
- "Title – Function – Company, City" then "Mon YYYY – Present" on the next line
- Duration-only: "3 Years experience as a Site Supervisor in UCC Pvt. Ltd"
  → employer "UCC Pvt. Ltd", title "Site Supervisor", start null, end null, statedDurationYears 3

Rules:
- Copy values from the text. Never invent employers or titles.
- Dates as month and year when possible (e.g. "Jan 2020"). Use "Present" for ongoing roles.
- Experience entries may state only a duration instead of dates, e.g. "X years experience as [title] at/in [company]."
  Still extract employer and title in this case, set start/end to null, and put the number in statedDurationYears.
  Never omit an entry just because dates are missing — return it with nulls instead.
- Fill every field that is visible in the text. Partial rows are valid (employer-only, title-only, duration-only, etc.).
- Always set domainMatch to null (occupation matching is disabled for now).
- statedDurationYears is a number of years when an explicit duration is stated without calendar dates; otherwise null.
- Sort is not required; the server will sort. Prefer most recent roles first if you can.
- Skip Education / Skills / Projects / Certifications sections — only paid or professional roles under Experience / Work History / Employment (or a short Experience: line on a CV/profile).
- If no jobs found, return {"rows": []}.
- confidence 0.0–1.0 when set.`;
}
