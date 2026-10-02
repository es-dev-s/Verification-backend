import { z } from "zod";

export const degreeLevelSchema = z.enum([
  "diploma",
  "advanced_diploma",
  "bachelor",
  "master",
  "phd",
]);

export type DegreeLevelLabel = z.infer<typeof degreeLevelSchema>;

export const educationExtractSchema = z.object({
  degreeTitle: z.string().nullable(),
  institution: z.string().nullable(),
  country: z.string().nullable(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  statedDuration: z.string().nullable(),
  multipleBachelors: z.boolean().optional().default(false),
  confidence: z
    .object({
      degreeTitle: z.number().nullable().optional(),
      institution: z.number().nullable().optional(),
      country: z.number().nullable().optional(),
      start: z.number().nullable().optional(),
      end: z.number().nullable().optional(),
      statedDuration: z.number().nullable().optional(),
    })
    .optional(),
});

export type EducationExtract = z.infer<typeof educationExtractSchema>;

/** One education entry detected on a CV, tagged with a degree-level guess. */
export const cvEducationEntrySchema = educationExtractSchema.extend({
  degreeLevel: degreeLevelSchema,
});

export type CvEducationEntry = z.infer<typeof cvEducationEntrySchema>;

export const cvEducationExtractSchema = z.object({
  entries: z.array(cvEducationEntrySchema),
});

export type CvEducationExtract = z.infer<typeof cvEducationExtractSchema>;

export const educationSourceExtractSchema = educationExtractSchema.extend({
  documentId: z.string(),
  documentType: z.enum(["CV", "TRANSCRIPT", "CERTIFICATE"]),
  /** Present when the source is a CV multi-entry flatten, or when a level-scoped parse tags the row. */
  degreeLevel: degreeLevelSchema.nullable().optional(),
});

export const educationMultiExtractSchema = z.object({
  sources: z.array(educationSourceExtractSchema),
});

export type EducationMultiExtract = z.infer<typeof educationMultiExtractSchema>;

export const experienceRowSchema = z.object({
  employer: z.string().nullable(),
  title: z.string().nullable(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  domainMatch: z.boolean().nullable(),
  confidence: z
    .object({
      employer: z.number().nullable().optional(),
      title: z.number().nullable().optional(),
      start: z.number().nullable().optional(),
      end: z.number().nullable().optional(),
    })
    .optional(),
});

export const experienceExtractSchema = z.object({
  rows: z.array(experienceRowSchema),
});

export type ExperienceExtract = z.infer<typeof experienceExtractSchema>;

export type DocumentTypeLabel = "CV" | "TRANSCRIPT" | "CERTIFICATE";

export type PerSourceEducation = {
  documentId: string;
  documentType: DocumentTypeLabel;
  extract: EducationExtract;
  degreeLevel?: DegreeLevelLabel | null;
};
