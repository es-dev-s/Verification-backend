-- Multi-degree levels: DegreeLevel enum, Qualification replaces Bachelors,
-- Document/ReadJob/FieldSource scoped by degreeLevel, Case.selectedDegreeLevels.

-- CreateEnum
CREATE TYPE "DegreeLevel" AS ENUM ('diploma', 'advanced_diploma', 'bachelor', 'master', 'phd');

-- AlterTable Case: selected degree levels (default empty; backfilled below)
ALTER TABLE "Case" ADD COLUMN "selectedDegreeLevels" "DegreeLevel"[] DEFAULT ARRAY[]::"DegreeLevel"[];

-- AlterTable Document: optional degree level (null for CV)
ALTER TABLE "Document" ADD COLUMN "degreeLevel" "DegreeLevel";

-- AlterTable ReadJob: optional degree level (null for EXPERIENCE)
ALTER TABLE "ReadJob" ADD COLUMN "degreeLevel" "DegreeLevel";

-- CreateTable Qualification (replaces Bachelors)
CREATE TABLE "Qualification" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "degreeLevel" "DegreeLevel" NOT NULL,
    "degreeTitle" TEXT,
    "institution" TEXT,
    "country" TEXT,
    "durationYears" DOUBLE PRECISION,
    "durationCalculated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Qualification_pkey" PRIMARY KEY ("id")
);

-- Migrate existing Bachelors rows → Qualification at bachelor level
INSERT INTO "Qualification" ("id", "caseId", "degreeLevel", "degreeTitle", "institution", "country", "durationYears", "durationCalculated")
SELECT
    md5("caseId" || ':bachelor') || substr(md5(random()::text), 1, 8),
    "caseId",
    'bachelor'::"DegreeLevel",
    "degreeTitle",
    "institution",
    "country",
    "durationYears",
    "durationCalculated"
FROM "Bachelors";

-- Tag existing transcript/certificate docs as bachelor (single-degree legacy)
UPDATE "Document"
SET "degreeLevel" = 'bachelor'::"DegreeLevel"
WHERE "type" IN ('TRANSCRIPT', 'CERTIFICATE')
  AND "degreeLevel" IS NULL;

-- Tag existing EDUCATION read jobs as bachelor
UPDATE "ReadJob"
SET "degreeLevel" = 'bachelor'::"DegreeLevel"
WHERE "section" = 'EDUCATION'
  AND "degreeLevel" IS NULL;

-- FieldSource: add degreeLevel, backfill bachelor for existing education fields, replace unique
ALTER TABLE "FieldSource" ADD COLUMN "degreeLevel" "DegreeLevel";

UPDATE "FieldSource"
SET "degreeLevel" = 'bachelor'::"DegreeLevel"
WHERE "degreeLevel" IS NULL;

DROP INDEX IF EXISTS "FieldSource_caseId_field_key";
CREATE UNIQUE INDEX "FieldSource_caseId_field_degreeLevel_key" ON "FieldSource"("caseId", "field", "degreeLevel");

-- Cases that already had bachelors / academic docs: select bachelor by default
UPDATE "Case" c
SET "selectedDegreeLevels" = ARRAY['bachelor'::"DegreeLevel"]
WHERE EXISTS (SELECT 1 FROM "Qualification" q WHERE q."caseId" = c."id")
   OR EXISTS (
     SELECT 1 FROM "Document" d
     WHERE d."caseId" = c."id" AND d."type" IN ('TRANSCRIPT', 'CERTIFICATE')
   );

-- Drop legacy Bachelors table
DROP TABLE "Bachelors";

-- Indexes
CREATE INDEX "Document_caseId_type_degreeLevel_idx" ON "Document"("caseId", "type", "degreeLevel");

DROP INDEX IF EXISTS "ReadJob_caseId_section_idx";
CREATE INDEX "ReadJob_caseId_section_degreeLevel_idx" ON "ReadJob"("caseId", "section", "degreeLevel");

CREATE UNIQUE INDEX "Qualification_caseId_degreeLevel_key" ON "Qualification"("caseId", "degreeLevel");
CREATE INDEX "Qualification_caseId_idx" ON "Qualification"("caseId");

CREATE INDEX "FieldSource_caseId_degreeLevel_idx" ON "FieldSource"("caseId", "degreeLevel");

-- FKs
ALTER TABLE "Qualification" ADD CONSTRAINT "Qualification_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
