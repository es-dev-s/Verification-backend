# Verification Engine API

Fastify + Prisma + BullMQ workers for document upload, extract, and parse.

## Run locally

```bash
# Terminal 1 — API
npm run dev

# Terminal 2 — workers
npm run worker
```

Requires `DATABASE_URL`, `REDIS_URL`, Gemini keys (`GEMINI_API_KEY` + optional `_2`…), and a running titlextractor at `EXTRACTOR_URL` (default `http://localhost:5000`).

- **Extract** stays async (BullMQ worker → titlextractor).
- **Read** is synchronous in the API (one Gemini call per section; results cached by source hash).

## Scripts

- `npm run prisma:migrate` — create/apply migrations
- `npm run prisma:deploy` — deploy migrations
- `npm run build` / `npm start` — production API
- `npm run start:worker` — extract worker only (Read is sync in the API)
