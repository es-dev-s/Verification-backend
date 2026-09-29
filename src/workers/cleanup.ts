import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";

export async function failStuckExtractions(): Promise<number> {
  const cutoff = new Date(
    Date.now() - config.stuckExtractMinutes * 60 * 1000,
  );
  const result = await prisma.document.updateMany({
    where: {
      status: "EXTRACTING",
      updatedAt: { lt: cutoff },
    },
    data: {
      status: "FAILED",
      error: "Extraction timed out — please re-upload",
    },
  });
  return result.count;
}
