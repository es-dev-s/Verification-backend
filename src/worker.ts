import { Worker } from "bullmq";
import { config } from "./config.js";
import {
  EXTRACT_QUEUE,
  redisConnection,
  closeQueues,
} from "./lib/queues.js";
import { prisma } from "./lib/prisma.js";
import { closeRedis } from "./lib/redis.js";
import { failStuckExtractions } from "./workers/cleanup.js";
import { processExtractJob } from "./workers/extract.js";

async function main() {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const connection = redisConnection();

  const extractWorker = new Worker(
    EXTRACT_QUEUE,
    async (job) => {
      const documentId = String(
        (job.data as { documentId?: string }).documentId ?? job.id,
      );
      await processExtractJob(documentId);
    },
    {
      connection,
      concurrency: config.extractConcurrency,
    },
  );

  extractWorker.on("failed", (job, err) => {
    console.error(`[extract] failed ${job?.id}:`, err.message);
  });

  console.log(
    `Extract worker started (concurrency=${config.extractConcurrency}). Read/parse runs synchronously in the API.`,
  );

  const cleanupTimer = setInterval(() => {
    failStuckExtractions()
      .then((n) => {
        if (n > 0) console.log(`[cleanup] marked ${n} stuck extractions failed`);
      })
      .catch((err) => console.error("[cleanup]", err));
  }, 60_000);

  const shutdown = async () => {
    clearInterval(cleanupTimer);
    await extractWorker.close();
    await closeQueues();
    await closeRedis();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
