-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('DRAFT', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('CV', 'TRANSCRIPT', 'CERTIFICATE');

-- CreateEnum
CREATE TYPE "DocumentFormat" AS ENUM ('PDF', 'PNG', 'JPG', 'DOCX');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('QUEUED', 'EXTRACTING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "ReadSection" AS ENUM ('EDUCATION', 'EXPERIENCE');

-- CreateEnum
CREATE TYPE "ReadJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "targetOccupation" TEXT,
    "status" "CaseStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "draftJson" JSONB,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "originalName" TEXT NOT NULL,
    "format" "DocumentFormat" NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "text" TEXT,
    "extractionMethod" TEXT,
    "ocrConfidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReadJob" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "section" "ReadSection" NOT NULL,
    "inputHash" TEXT NOT NULL,
    "status" "ReadJobStatus" NOT NULL DEFAULT 'QUEUED',
    "resultJson" JSONB,
    "error" TEXT,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReadJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperienceRow" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "employer" TEXT,
    "title" TEXT,
    "start" TEXT,
    "end" TEXT,
    "domainSuggested" BOOLEAN,
    "domainFinal" BOOLEAN,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ExperienceRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bachelors" (
    "caseId" TEXT NOT NULL,
    "degreeTitle" TEXT,
    "institution" TEXT,
    "country" TEXT,
    "durationYears" DOUBLE PRECISION,
    "durationCalculated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Bachelors_pkey" PRIMARY KEY ("caseId")
);

-- CreateTable
CREATE TABLE "FieldSource" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "sourceDocumentId" TEXT,
    "extractedValue" TEXT,
    "finalValue" TEXT,
    "confidence" DOUBLE PRECISION,
    "alternatives" JSONB,

    CONSTRAINT "FieldSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Case_clientId_idx" ON "Case"("clientId");

-- CreateIndex
CREATE INDEX "Document_caseId_idx" ON "Document"("caseId");

-- CreateIndex
CREATE INDEX "Document_status_idx" ON "Document"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Document_caseId_sha256_key" ON "Document"("caseId", "sha256");

-- CreateIndex
CREATE INDEX "ReadJob_caseId_section_idx" ON "ReadJob"("caseId", "section");

-- CreateIndex
CREATE INDEX "ReadJob_status_idx" ON "ReadJob"("status");

-- CreateIndex
CREATE INDEX "ExperienceRow_caseId_idx" ON "ExperienceRow"("caseId");

-- CreateIndex
CREATE INDEX "FieldSource_caseId_idx" ON "FieldSource"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "FieldSource_caseId_field_key" ON "FieldSource"("caseId", "field");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReadJob" ADD CONSTRAINT "ReadJob_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperienceRow" ADD CONSTRAINT "ExperienceRow_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bachelors" ADD CONSTRAINT "Bachelors_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldSource" ADD CONSTRAINT "FieldSource_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldSource" ADD CONSTRAINT "FieldSource_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
