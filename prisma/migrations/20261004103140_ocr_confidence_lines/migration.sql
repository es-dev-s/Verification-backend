-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "ocrLines" JSONB;

-- AlterTable
ALTER TABLE "ExtractedSubject" ADD COLUMN     "ocrConfidence" DOUBLE PRECISION;
