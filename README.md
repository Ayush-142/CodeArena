# CodeArena

Minimal monorepo scaffold for the online judge platform.

## Services
- API: Express + TypeScript
- Worker: BullMQ consumer
- Frontend: Next.js + Tailwind

## Local development

1. Install dependencies:
   npm install

2. Start infrastructure:
   docker compose up -d

3. Start services in separate terminals:
   npm run dev:api
   npm run dev:worker
   npm run dev:frontend

## Verify
Run the following from the repository root:

```bash
npm run dev:api
curl http://localhost:3001/health
curl http://localhost:3001/ready
```

```bash
npm run dev:worker
```

```bash
npm run dev:frontend
curl http://localhost:3000
```

If you want to confirm the infrastructure containers are running:

```bash
docker compose ps
```
