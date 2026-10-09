-- AlterTable
ALTER TABLE "CareerEpisode" ADD COLUMN     "hasCalculations" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasDataTables" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasDrawingsCad" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasQuantifiableOutcomes" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasSiteProductImages" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasStandardsReferenced" BOOLEAN NOT NULL DEFAULT false;
