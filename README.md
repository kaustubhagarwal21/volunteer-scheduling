# Volunteer Scheduling

Coordinators set up programs and shifts; volunteers claim the shifts they can work. How many spots each shift still needs is always a live count, double-booking is impossible, and every shift keeps a history nobody can rewrite.

Take-home assignment 18 for BUSY Infotech. The original brief is in [docs/brief.md](docs/brief.md).

**Reviewers: start with [SUBMISSION.md](SUBMISSION.md)** (live link, demo logins, a per-goal walkthrough).

| | |
|---|---|
| Architecture and request path | [docs/architecture.md](docs/architecture.md) |
| Tables, constraints, 100× | [docs/schema.md](docs/schema.md) |
| Decisions and reversals | [docs/decisions.md](docs/decisions.md) |
| How the work went | [docs/plan.md](docs/plan.md) |
| AI prompts used | [docs/ai-prompts.md](docs/ai-prompts.md) |

## Layout

```
server/   Express 5 + TypeScript API, plain SQL (node-postgres)
  migrations/001_init.sql   the schema, including the rules the database enforces
  src/shifts/lifecycle.ts   locking order and fill-state changes
  src/signups/service.ts    the signup and cancellation rules
  test/                     265 tests against a real Postgres
client/   React 19 + Vite single-page app
```

## Run it

```bash
npm install
docker compose up -d && cp server/.env.example server/.env
npm run seed    # schema and demo data
npm run dev     # http://localhost:5173
npm test
```
