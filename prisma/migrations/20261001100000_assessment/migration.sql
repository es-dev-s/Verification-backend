-- CreateTable
CREATE TABLE "Assessment" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "anzscoCode" TEXT,
    "confidence" TEXT,
    "determination" TEXT NOT NULL,
    "recommended" BOOLEAN NOT NULL DEFAULT false,
    "foundationalMatched" INTEGER NOT NULL DEFAULT 0,
    "foundationalExpected" INTEGER NOT NULL DEFAULT 5,
    "coreMatched" INTEGER NOT NULL DEFAULT 0,
    "coreExpected" INTEGER NOT NULL DEFAULT 9,
    "foundationalPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "corePct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tier1Outcome" TEXT,
    "tier2Outcome" TEXT,
    "tier3GateMet" BOOLEAN NOT NULL DEFAULT false,
    "workExperienceBoost" BOOLEAN NOT NULL DEFAULT false,
    "qualificationsUsed" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "explanation" TEXT,
    "resultJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractedSubject" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "documentId" TEXT,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "credits" TEXT,
    "grade" TEXT,
    "yearOrSemester" TEXT,
    "qualification" TEXT NOT NULL DEFAULT 'unknown',
    "sourceSnippet" TEXT,
    "isRepeat" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ExtractedSubject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Assessment_caseId_key" ON "Assessment"("caseId");

-- CreateIndex
CREATE INDEX "Assessment_caseId_idx" ON "Assessment"("caseId");

-- CreateIndex
CREATE INDEX "ExtractedSubject_caseId_idx" ON "ExtractedSubject"("caseId");

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedSubject" ADD CONSTRAINT "ExtractedSubject_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
