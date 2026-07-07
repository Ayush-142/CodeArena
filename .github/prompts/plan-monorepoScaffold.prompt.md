## Plan: Scaffold monorepo skeleton

Create a minimal monorepo layout for the API, worker, and frontend services with shared workspace tooling, local infrastructure via Docker Compose, and starter implementations for health checks and queue consumption.

Steps
1. Add root workspace configuration, Docker Compose, gitignore, and README.
2. Scaffold the Express API with TypeScript, dotenv, Mongoose, Redis, and a health route.
3. Scaffold the BullMQ worker with TypeScript and Redis connectivity, including a worker .env.example with Redis URL at minimum.
4. Scaffold the Next.js + Tailwind frontend with an initial home page.
5. Install dependencies and verify each service starts with the expected local connections.

Relevant files
- /workspace root package.json, docker-compose.yml, .gitignore, README.md
- /api package.json, tsconfig.json, .env.example, src/index.ts
- /worker package.json, tsconfig.json, .env.example, src/index.ts
- /frontend package.json, tsconfig.json, next-env.d.ts, postcss.config.js, tailwind.config.ts, app/layout.tsx, app/page.tsx, app/globals.css

README expectations
- Include a "Verify" section with exact commands and curl calls to confirm the API, worker, and frontend are up and connected.
- The commands should be written so the user can run them directly from the repo root.
