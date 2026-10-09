import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { config } from "./config.js";
import clientIdPlugin from "./plugins/clientId.js";
import { assessRoutes } from "./assess/routes.js";
import { riskRoutes } from "./risk/routes.js";
import { careerEpisodeRoutes } from "./routes/careerEpisodes.js";
import { caseReviewRoutes } from "./routes/caseReview.js";
import { caseRoutes } from "./routes/cases.js";
import { documentRoutes } from "./routes/documents.js";
import { jobRoutes } from "./routes/jobs.js";
import { prisma } from "./lib/prisma.js";
import { closeQueues } from "./lib/queues.js";
import { closeRedis } from "./lib/redis.js";

async function main() {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const app = Fastify({
    logger: true,
    bodyLimit: config.maxUploadBytes + 1024 * 100,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      try {
        const text = typeof body === "string" ? body : "";
        done(null, text ? JSON.parse(text) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  await app.register(cors, {
    origin: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "X-Client-Id"],
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    max: 200,
    timeWindow: "1 minute",
  });
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1 },
  });
  await app.register(clientIdPlugin);

  app.get("/health", async () => ({ ok: true }));

  await app.register(caseRoutes);
  await app.register(documentRoutes);
  await app.register(careerEpisodeRoutes);
  await app.register(caseReviewRoutes);
  await app.register(jobRoutes);
  await app.register(assessRoutes);
  await app.register(riskRoutes);

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`API listening on :${config.port}`);

  const shutdown = async () => {
    await app.close();
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
