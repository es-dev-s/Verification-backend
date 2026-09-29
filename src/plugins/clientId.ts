import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";

declare module "fastify" {
  interface FastifyRequest {
    clientId: string;
  }
}

const clientIdPlugin: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req) => {
    const header = req.headers["x-client-id"];
    const value = Array.isArray(header) ? header[0] : header;
    req.clientId =
      value && /^[a-zA-Z0-9_-]{8,128}$/.test(value) ? value : randomUUID();
  });
};

export default fp(clientIdPlugin);
