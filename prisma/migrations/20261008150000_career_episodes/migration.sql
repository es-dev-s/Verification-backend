-- CreateEnum
CREATE TYPE "ProjectSource" AS ENUM ('WORK_BASED', 'ACADEMIC_PERSONAL', 'FIRM_PREPARED');

-- CreateTable
CREATE TABLE "CareerEpisode" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "projectSource" "ProjectSource",
    "experienceRowId" TEXT,
    "experienceLabel" TEXT,
    "originalName" TEXT NOT NULL,
    "format" "DocumentFormat" NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "fileData" BYTEA NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CareerEpisode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CareerEpisode_caseId_idx" ON "CareerEpisode"("caseId");

-- AddForeignKey
ALTER TABLE "CareerEpisode" ADD CONSTRAINT "CareerEpisode_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
