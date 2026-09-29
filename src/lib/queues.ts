import { Queue, type ConnectionOptions } from "bullmq";
import { config } from "../config.js";

export const EXTRACT_QUEUE = "extract";

export function redisConnection(): ConnectionOptions {
  const url = new URL(config.redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

let extractQueue: Queue | null = null;

export function getExtractQueue(): Queue {
  if (!extractQueue) {
    extractQueue = new Queue(EXTRACT_QUEUE, {
      connection: redisConnection(),
      defaultJobOptions: {
        attempts: config.extractAttempts,
        backoff: { type: "exponential", delay: 3000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return extractQueue;
}

export async function closeQueues(): Promise<void> {
  await extractQueue?.close();
  extractQueue = null;
}
