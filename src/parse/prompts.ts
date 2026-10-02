import type { DocumentTypeLabel } from "./schemas.js";

/**
 * CV-only: extract every degree/diploma entry found, each tagged with a degreeLevel guess.
 * Server filters to the case's selected levels later — do not drop entries here.
 */
export function cvEducationSystemPrompt(): string {
  return `You extract ALL education / qualification entries from a CV/resume plain text.

Return JSON only matching this schema exactly:
{
  "entries": [
    {
      "degreeLevel": "diploma" | "advanced_diploma" | "bachelor" | "master" | "phd",
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

degreeLevel mapping (use the best match for each entry):
- "PhD", "Doctor of Philosophy", "DPhil", "EdD" → phd
- "Master", "M.Sc", "MSc", "M.Eng", "MBA", "MPhil" → master
- "Bachelor", "B.Sc", "BSc", "B.Eng", "B.Tech", "BA", "BS", "undergraduate degree" → bachelor
- "Advanced Diploma", "Adv. Diploma", "Graduate Diploma" (when clearly advanced diploma) → advanced_diploma
- "Diploma", "Dip.", "Ordinary Diploma" (not advanced) → diploma

Rules:
- Return one entry per distinct award found under Education / Qualifications / Academic background.
- If the CV lists several degrees (e.g. Bachelor + Master), return ALL of them — never keep only the bachelor's.
- If two bachelor's appear, include both; set multipleBachelors true on each bachelor entry (or the first).
- A line labeled "Qualification:", "Award:", "Course:", or "Program:" followed by a value is an explicitly stated degree title (VET/RTO/TAFE as well as university) — use that value; do not leave degreeTitle null.
- Australian VET titles often start with a training package code (e.g. "ICT60220", "BSB50420"). Strip that leading code and return only the qualification name. Do not confuse these with per-unit codes in a subject table (e.g. "BSBCRT611").
- Copy wording as written (after stripping a leading training package code). Never invent institution, country, or dates.
- Never leave truncated titles or unclosed parentheses; omit curly braces / JSON artifacts.
- country only if stated near that education line (not from work locations).
- statedDuration only for explicit duration phrases (e.g. "3 years"); otherwise null.
- start/end from enrollment/graduation years when present; use "Present" for ongoing study.
- If no education entries found, return {"entries": []}.
- confidence 0.0–1.0 when a value is set; null when value is null.

Example:
Text:
  EDUCATION
  M.Sc. Petroleum Engineering | Suez University | 2025
  B.Sc. Petroleum Engineering | METU | 2021
  Advanced Diploma of IT | Bella College Australia | 2020
Expected entries (order flexible):
  { degreeLevel: "master", degreeTitle: "M.Sc. Petroleum Engineering", institution: "Suez University", ... }
  { degreeLevel: "bachelor", degreeTitle: "B.Sc. Petroleum Engineering", institution: "METU", ... }
  { degreeLevel: "advanced_diploma", degreeTitle: "Advanced Diploma of IT", institution: "Bella College Australia", ... }

Example — Australian VET/RTO labeled qualification:
Text:
  Qualification: ICT60220 Advanced Diploma of Information Technology
  BELLA COLLEGE AUSTRALIA
  Queensland, Australia
Expected:
  { degreeLevel: "advanced_diploma", degreeTitle: "Advanced Diploma of Information Technology", institution: "BELLA COLLEGE AUSTRALIA", country: "Australia", ... }
  (Strip "ICT60220"; do not leave degreeTitle null.)`;
}

export function educationMultiSystemPrompt(): string {
  return `You extract education fields for a single target degree level from one or more labeled documents' plain text.

You will receive several sources, each tagged with documentId and documentType (CV, TRANSCRIPT, or CERTIFICATE).
A target degree level may be stated in the user message. Extract fields SEPARATELY for each source for that level only. Do not merge across sources — the server merges by priority.

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
- CERTIFICATE: Prefer awarded title and issuing institution as printed for the target level.
- TRANSCRIPT: Prefer program name, institution, and enrollment/session years near the header.
  Also covers VET/RTO/TAFE records of results — not only university transcripts.
  Degree/program titles appear under many label spellings — treat all of these as stated degreeTitle
  (do not leave null when present): Qualification, Award, Course, Program, Programme, Branch,
  Department, Department/Program, Program/Department, Degrees Awarded, Type of Academic Degree.
  Combine a degree type/abbrev with the program/branch field when both appear
  (e.g. "B.S." + "Petroleum and Natural Gas Engineering" → "B.S. Petroleum and Natural Gas Engineering";
  "Bachelor's Degree" + "Materials Science And Engineering" → "Bachelor's Degree in Materials Science And Engineering";
  "BACHELOR OF TECHNOLOGY (B.Tech)" + Branch "CIVIL ENGINEERING" → include the branch).
  On bilingual transcripts, prefer the English parenthetical after Program/Department or Type of Academic Degree.
- CV: Prefer the education line that matches the target degree level if present.

Explicit qualification labels (stated, not inferred) — especially for TRANSCRIPT sources:
- If a line is labeled "Qualification:", "Award:", "Course:", "Program:", "Programme:", "Branch:",
  or "Department:" followed by a value, that value is stated (not inferred). Never return degreeTitle
  null when such a labeled line exists for the target level.
- Australian qualifications often prefix a training package / national code (e.g. "ICT60220", "BSB50420")
  immediately before the title. Strip that leading code and return only the name:
  "ICT60220 Advanced Diploma of Information Technology" → degreeTitle "Advanced Diploma of Information Technology".
- Do NOT confuse qualification codes with per-unit codes in a subject/results table (e.g. "BSBCRT611", "ICTNWK612") — those are unrelated.
- Do NOT invent a title from course/unit lists alone when no award/program/branch line is printed.

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
  B. Sc Civil Engineering Technology
Expected when present:
  institution ≈ "Government College University Faisalabad" (or as printed)
  country = "Pakistan"
  degreeTitle from the award line when printed; null if the transcript never names the award.

Example D — CV education block (target bachelor):
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

Example E — Australian VET/RTO transcript (target advanced_diploma):
Text:
  Record of Results
  Qualification: ICT60220 Advanced Diploma of Information Technology
  ...
  Unit Code Unit Name
  BSBCRT611 Apply critical thinking for complex problem solving
  ...
  BELLA COLLEGE AUSTRALIA
  Address: ... Spring Hill, Queensland, Australia, 4000
Expected for that source:
  degreeTitle = "Advanced Diploma of Information Technology"  (strip leading ICT60220; do NOT null)
  institution ≈ "BELLA COLLEGE AUSTRALIA"
  country = "Australia"
  Do NOT use unit codes like BSBCRT611 as the degree title.

Example F — bilingual transcript Program/Department (target bachelor):
Text:
  (Program/Department)
  (Materials Science And Engineering Pr.)
  (Type of Academic Degree)
  (Bachelor's Degree)
Expected:
  degreeTitle ≈ "Bachelor's Degree in Materials Science And Engineering"
  (strip trailing "Pr."; do NOT leave null)

Example G — DEGREES AWARDED + department header (target bachelor):
Text:
  ...HAMZAPetroleum and Natural Gas EngineeringCOURSE NAME...
  DEGREES AWARDED ... B.S. February 08, 2021
  DEPARTMENT/ PROGRAM
Expected:
  degreeTitle ≈ "B.S. Petroleum and Natural Gas Engineering"
  (combine awarded abbrev with the program name printed before COURSE NAME)

Rules:
- Include one entry in "sources" for every documentId provided in the user message (even if all fields are null).
- Echo documentId and documentType exactly as given.
- Target only the degree level requested in the user message (default bachelor if unspecified). Ignore other levels on the same document.
- If several awards of the same target level appear in one source, take the first and set multipleBachelors to true when the target is bachelor.
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
      "This is a degree certificate or diploma. Prefer the awarded title and issuing institution as printed on the certificate.",
    TRANSCRIPT:
      "This is an academic transcript. Prefer program/qualification/branch/department name (including bilingual Program/Department and DEGREES AWARDED), institution, and SESSION/BATCH year ranges near the header. Ignore Result Declaration / Date of Issue stamps.",
    CV: "This is a CV/resume. Prefer the education line matching the target degree level. Do not invent details.",
  };

  return `You extract education fields from one document's plain text.
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
- Target the requested degree level (default bachelor). Ignore other levels unless they are clearly the intended award.
- If several matching awards appear, take the first and set multipleBachelors to true when applicable.
- A "Qualification:", "Award:", "Course:", or "Program:" line is an explicitly stated degree title (including VET/RTO/TAFE). Strip a leading Australian training package code (e.g. ICT60220) before returning degreeTitle.
- Every value is nullable. Never guess, invent, or normalize institution/degree wording — copy as written (after code strip).
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
      "domainMatch": true|false|null,
      "confidence": {
        "employer": number|null,
        "title": number|null,
        "start": number|null,
        "end": number|null
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
  → employer "UCC Pvt. Ltd", title "Site Supervisor", start null, end null

Rules:
- Copy values from the text. Never invent employers or titles.
- Dates as month and year when possible (e.g. "Jan 2020"). Use "Present" for ongoing roles.
- Experience entries may state only a duration instead of dates, e.g. "X years experience as [title] at/in [company]."
  Still extract employer and title in this case, and set start/end to null.
  Never omit an entry just because dates are missing — return it with nulls instead.
- Fill every field that is visible in the text. Partial rows are valid (employer-only, title-only, etc.).
- For each work experience entry, determine if the role and its duties are engineering-related (e.g. design, construction, technical or site supervision, maintenance, or engineering analysis work). Return domainMatch: true or false based only on the role/duties text. Do not guess if duties aren't described — use null when unclear.
- Do not compare roles against any target occupation. domainMatch is engineering-related only.
- Sort is not required; the server will sort. Prefer most recent roles first if you can.
- Skip Education / Skills / Projects / Certifications sections — only paid or professional roles under Experience / Work History / Employment (or a short Experience: line on a CV/profile).
- If no jobs found, return {"rows": []}.
- confidence 0.0–1.0 when set.`;
}
