-- CreateEnum
CREATE TYPE "CaseReviewStatus" AS ENUM ('APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "CaseReview" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "status" "CaseReviewStatus" NOT NULL,
    "comment" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CaseReview_caseId_key" ON "CaseReview"("caseId");

-- AddForeignKey
ALTER TABLE "CaseReview" ADD CONSTRAINT "CaseReview_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
