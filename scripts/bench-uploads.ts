/**
 * Offline bench: extract text from uploads/extracted samples, run Gemini
 * education + experience parse, write reports under uploads/bench-out.
 *
 * Usage: npx tsx scripts/bench-uploads.ts
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(apiRoot, "..");
loadDotenv({ path: path.join(apiRoot, ".env") });

// Import after dotenv so Gemini keys load
const { generateJson } = await import("../src/lib/gemini.js");
const { correctOcrEducationText } = await import("../src/parse/ocrCorrect.js");
const {
  educationMultiSystemPrompt,
  experienceSystemPrompt,
} = await import("../src/parse/prompts.js");
const {
  educationMultiExtractSchema,
  experienceExtractSchema,
} = await import("../src/parse/schemas.js");
const { mergeEducation } = await import("../src/parse/mergeEducation.js");
const {
  heuristicsEducationFromText,
  heuristicsExperienceFromText,
} = await import("../src/parse/heuristics.js");

const EXTRACTOR = process.env.EXTRACTOR_URL ?? "http://localhost:5000";
const SAMPLES = path.join(repoRoot, "uploads", "extracted");
const OUT = path.join(repoRoot, "uploads", "bench-out");
/** Set BENCH_HEURISTICS_ONLY=1 to skip Gemini (uses cached text files when present). */
const HEURISTICS_ONLY = process.env.BENCH_HEURISTICS_ONLY === "1";

type Kind = "CV" | "TRANSCRIPT" | "CERTIFICATE";

const CLIENTS: Array<{
  id: string;
  files: Array<{ name: string; type: Kind }>;
}> = [
  {
    id: "01-gurram",
    files: [{ name: "1. Gurram JNTUH.pdf", type: "TRANSCRIPT" }],
  },
  {
    id: "02-aleena",
    files: [
      {
        name: "2. Aleena Advanced Diploma of Information Technology Record of Results.pdf",
        type: "TRANSCRIPT",
      },
    ],
  },
  {
    id: "03-shah-khalid",
    files: [
      { name: "3. Shah Khalid Resume.png", type: "CV" },
      { name: "3. shah Khalid CMM.jpeg", type: "CERTIFICATE" },
    ],
  },
  {
    id: "04-biwott",
    files: [
      { name: "4. Josphat Biwott Resume- (1).docx", type: "CV" },
      { name: "4. BIWOTT DEGREE AND CERT.pdf", type: "CERTIFICATE" },
    ],
  },
  {
    id: "05-gokul",
    files: [{ name: "5. Gokul- Bachelors transcript.pdf", type: "TRANSCRIPT" }],
  },
  {
    id: "06-ahmad",
    files: [
      { name: "6. Ahmad cv ahmad bilal (1).docx", type: "CV" },
      { name: "6.Ahmad bs  transcript.pdf", type: "TRANSCRIPT" },
    ],
  },
  {
    id: "07-rahna",
    files: [
      { name: "7. Rahna - cv.docx", type: "CV" },
      { name: "7. Rahna Official Transcript.pdf", type: "TRANSCRIPT" },
    ],
  },
  {
    id: "08-khaled",
    files: [
      { name: "8. Khaled Abdalla - CV.docx", type: "CV" },
      { name: "8. Khaled Transcript.pdf", type: "TRANSCRIPT" },
    ],
  },
  {
    id: "09-faizan",
    files: [
      { name: "9. Faizan Transcript.pdf", type: "TRANSCRIPT" },
      { name: "9. Faizan Verification.pdf", type: "CERTIFICATE" },
    ],
  },
  {
    id: "10-cem",
    files: [
      { name: "10. Cem_Ergen_Resume.docx", type: "CV" },
      { name: "10. Cem Ergen_Transcript.pdf", type: "TRANSCRIPT" },
    ],
  },
];

async function extractText(filePath: string): Promise<{
  ok: boolean;
  raw_text: string;
  method?: string;
  error?: string;
}> {
  const bytes = await readFile(filePath);
  const form = new FormData();
  const blob = new Blob([bytes]);
  form.append("file", blob, path.basename(filePath));
  const res = await fetch(`${EXTRACTOR}/extract-text`, {
    method: "POST",
    body: form,
  });
  const json = (await res.json()) as {
    ok?: boolean;
    raw_text?: string;
    method?: string;
    error?: string;
  };
  return {
    ok: Boolean(json.ok && (json.raw_text ?? "").trim()),
    raw_text: json.raw_text ?? "",
    method: json.method,
    error: json.error,
  };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const summary: unknown[] = [];

  for (const client of CLIENTS) {
    console.log(`\n======== ${client.id} ========`);
    const sources: Array<{
      documentId: string;
      documentType: Kind;
      text: string;
      file: string;
      method?: string;
    }> = [];

    for (const f of client.files) {
      const snippetPath = path.join(
        OUT,
        `${client.id}__${f.type}__text.txt`,
      );
      let cleaned = "";
      let method = "cache";
      let ok = false;
      let extractErr = "";

      if (HEURISTICS_ONLY) {
        try {
          cleaned = await readFile(snippetPath, "utf8");
          ok = cleaned.trim().length > 0;
          console.log(`cache ${f.name}… chars=${cleaned.length}`);
        } catch {
          console.log(`cache miss ${f.name}`);
        }
      }

      if (!ok) {
        const fp = path.join(SAMPLES, f.name);
        console.log(`extract ${f.name}…`);
        const ex = await extractText(fp);
        cleaned = correctOcrEducationText(ex.raw_text, f.name).text;
        method = ex.method ?? "extract";
        ok = Boolean(ex.ok && cleaned.trim());
        extractErr = ex.error ?? "";
        await writeFile(snippetPath, cleaned.slice(0, 50_000), "utf8");
        console.log(
          `  ok=${ok} method=${method} chars=${cleaned.length} err=${extractErr}`,
        );
      }

      if (ok) {
        sources.push({
          documentId: createHash("sha1").update(f.name).digest("hex").slice(0, 12),
          documentType: f.type,
          text: cleaned.slice(0, 8_000),
          file: f.name,
          method,
        });
      }
    }

    // Heuristics quick view
    const heurEdu = sources.map((s) => ({
      file: s.file,
      type: s.documentType,
      ...heuristicsEducationFromText(s.text),
    }));
    const cv = sources.find((s) => s.documentType === "CV");
    const heurExp = cv
      ? heuristicsExperienceFromText(cv.text)
      : { rows: [] };

    // Always compute heuristics merge (useful when Gemini is down)
    const heurMerged = sources.length
      ? mergeEducation(
          sources.map((s) => ({
            documentId: s.documentId,
            documentType: s.documentType,
            extract: heuristicsEducationFromText(s.text),
          })),
        )
      : null;

    let geminiEdu: unknown = null;
    let geminiExp: unknown = null;
    let merged: unknown = heurMerged;
    let eduError: string | null = HEURISTICS_ONLY ? "heuristics_only" : null;
    let expError: string | null = HEURISTICS_ONLY ? "heuristics_only" : null;

    if (!HEURISTICS_ONLY && sources.length) {
      try {
        const prompt = sources
          .map(
            (d) =>
              `=== SOURCE documentId=${d.documentId} documentType=${d.documentType} ===\n${d.text}`,
          )
          .join("\n\n");
        console.log("gemini education…");
        const { data } = await generateJson(
          prompt,
          educationMultiSystemPrompt(),
          {
            deadlineMs: Date.now() + 45_000,
            maxTokens: 3072,
            responseSchema: educationMultiExtractSchema,
          },
        );
        geminiEdu = data;
        const parsed = educationMultiExtractSchema.safeParse(data);
        if (parsed.success) {
          merged = mergeEducation(
            parsed.data.sources.map((s) => ({
              documentId: s.documentId,
              documentType: s.documentType,
              extract: {
                degreeTitle: s.degreeTitle,
                institution: s.institution,
                country: s.country,
                start: s.start,
                end: s.end,
                statedDuration: s.statedDuration,
                multipleBachelors: s.multipleBachelors,
                confidence: s.confidence,
              },
            })),
          );
        }
      } catch (err) {
        eduError = err instanceof Error ? err.message : String(err);
        console.error("edu fail", eduError);
        merged = heurMerged;
      }
    }

    if (!HEURISTICS_ONLY && cv) {
      try {
        console.log("gemini experience…");
        const { data } = await generateJson(
          `--- CV text ---\n${cv.text.slice(0, 20_000)}`,
          experienceSystemPrompt(),
          {
            deadlineMs: Date.now() + 45_000,
            maxTokens: 3072,
            responseSchema: experienceExtractSchema,
          },
        );
        geminiExp = data;
      } catch (err) {
        expError = err instanceof Error ? err.message : String(err);
        console.error("exp fail", expError);
      }
    }

    const row = {
      client: client.id,
      sources: sources.map((s) => ({
        file: s.file,
        type: s.documentType,
        chars: s.text.length,
        method: s.method,
      })),
      heuristicsEducation: heurEdu,
      heuristicsExperience: heurExp.rows,
      heuristicsExperienceRows: heurExp.rows.length,
      heuristicsMerged: heurMerged,
      geminiEducation: geminiEdu,
      geminiExperience: geminiExp,
      merged,
      eduError,
      expError,
    };
    summary.push(row);
    await writeFile(
      path.join(OUT, `${client.id}__result.json`),
      JSON.stringify(row, null, 2),
      "utf8",
    );
    console.log(
      "heurMerged:",
      JSON.stringify(
        (heurMerged as { fields?: unknown } | null)?.fields ?? null,
        null,
        2,
      ),
    );
    console.log(`experience rows heur=${heurExp.rows.length}`);
    for (const r of heurExp.rows.slice(0, 6)) {
      console.log(
        `  - ${r.title ?? "?"} @ ${r.employer ?? "?"} (${r.start ?? "?"}–${r.end ?? "?"})`,
      );
    }
  }

  await writeFile(
    path.join(OUT, "_summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8",
  );
  console.log(`\nWrote ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
