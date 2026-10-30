# Plan

## How the work was split into sessions

The first build happened in **one evening session on 28 October 2026 (about 18:00–20:20 IST)**, working with Claude Code (an AI coding agent). In the same session, a fact-check of these docs, a seed fix and seeding the live database followed until about 20:50, and after a break, one small UI fix at 22:15. It used parallel AI agents for independent design review and for writing tests. The session had distinct, partly overlapping phases, and the git history shows them in roughly this order (the scaffold `8973077` was committed 38 seconds before the schema `9f493ac`, and the seed before the verification tests). Where several commits share a minute, I had written a stretch of work and then committed it as separate logical steps, in the order the work happened, rather than committing mid-stream. For example, the lifecycle API and the deadlock fix that its test exposed are two separate commits.

| Phase | Time (IST) | What happened |
|---|---|---|
| Read and decide | 18:00–18:15 | Read the brief. Chose the stack (TypeScript, React, Express, Postgres, plain SQL) and the pacing. Checked the machine: Docker wasn't running, and Node was 22.11 (see below). |
| Schema first, proven | 18:15–18:30 | Wrote the schema and a probe script against Postgres 17 proving each database-level rule before committing it (`9f493ac`). |
| Design review (in parallel) | 18:20–19:40 | Five independent AI reviewers attacked the written design while I kept building; a judge agent filtered their findings. |
| Scaffold, auth, client shell | 18:25–18:50 | Tooling, sessions and login, the client's API layer and layout, the pure recurrence and CSV functions. |
| Time model reversal | ~19:00 | Replaced the per-connection time zone with an explicit organisation clock (`636c2c2`). |
| Lifecycle core and API | 19:00–19:25 | Locking, derived state, signups and cancellations, close, edit and delete, finder; lifecycle tests, which found the deadlock (`77dcb9d`). |
| Apply the review | 19:25–19:40 | The membership race, the commit-time count check, the foreign-key cascade, the rule changes (`2f658a9`). |
| Remaining features | 19:30–19:45 | Programs, membership, generation, roster CSV, dashboard, alerts (`11f6823`). |
| Verification pass (in parallel) | 19:45–20:05 | Six AI test agents wrote 220 tests, one area each; 10 failed and exposed 4 bugs (`adee245`, then `a29554b`). |
| Client pages, seed, deployment | 19:40–20:15 | Every page, a demo seed, a production build check in a real browser, Render and CI configuration. |
| Documentation | 20:15–20:20 | These docs. |
| Fact-check and fixes | 20:20–20:50 | Four AI agents checked 531 claims in these docs against the code; 51 were corrected (`0600b92`). Replaying the demo steps moved one seeded shift (`c46ca28`). Seeded the live database. |
| Follow-up | 22:15 | Reworded the archived-program banner to match the archive rule (`f29fee3`). |

**My own sessions after the build** (reading and understanding the code, deploying, rewriting these docs in my own words) are recorded here as they happen:

| Date | Hours | What I did |
|---|---|---|
| 28–30 Oct | About 9 (about 12 in total with the build session) | Read the code and these docs with a walkthrough and the interview study guide. Deployed on Render: gave Render's GitHub app access to the repository, created the Blueprint from `render.yaml` and set `DATABASE_URL`. Tested the live site: the "Try this" steps in SUBMISSION.md as coordinator and as volunteer, plus a newly registered volunteer account (the demo data was reseeded afterwards). |

## Build order, and why that order

1. **Schema before code.** Goals 4, 9 and 10 are about rules that must hold under any sequence of requests. The cheapest place to get those wrong is the schema, so I wrote it first and ran a probe proving each rule (generated state rejects writes, CHECK stops over-filling, the exclusion constraint stops overlaps, history refuses UPDATE, DELETE and TRUNCATE) before writing any service code.
2. **Auth before features.** Every feature depends on knowing who is asking, and goal 1 must be enforced on the server.
3. **The shift lifecycle before everything else.** Signups, cancellations, closing and the timeline are the core of the brief. The other features (dashboard, alerts, generation) read the data the lifecycle writes, so their correctness depends on it.
4. **Tests next to the riskiest code.** The lifecycle tests were written alongside the lifecycle, including concurrency tests, and one of them found a real deadlock that only happens about 1 time in 12.
5. **Independent verification before committing the UI.** Agents that didn't write the API tested goals 1, 2 and 5–10 while I built the pages (goals 3 and 4 were covered by the lifecycle tests written with the code), and the bugs they found were fixed (`a29554b`) before the pages were committed (`31e8be9`).
6. **UI, seed, deployment, then docs.** The docs describe the system as it actually ended up, and their claims were fact-checked against the code.

## Estimate versus actual

- **The brief's budget** is about 12 hours of human work. With an AI agent doing most of the typing, the initial build took about 2 hours 20 minutes of wall-clock time, plus about 30 minutes for the fact-check and fixes. That doesn't compare like-for-like with 12 hours: much of it was waiting for parallel agents, and the real cost moves to reading, understanding and verifying the output, which is my own time after the build (table above).
- **What took longer than expected:** the design review took about 80 minutes of background time, the longest single step. That was because the reviewers actually ran concurrent SQL sessions against Postgres to prove race conditions rather than just reading the design. It was worth it: it found the membership race, which my own tests hadn't.
- **What took less:** the CRUD-shaped parts (programs, members, finder) went quickly once the locking pattern in `shifts/lifecycle.ts` existed.
- **Unplanned work:**
  - **Node version.** Vite 7+, Vitest 5 and React Router 8 need a newer Node (22.12+, or 22.22+ for React Router 8) and my machine has 22.11. I pinned Vite 6, Vitest 3, React Router 7 and TypeScript 5.9 instead of changing the machine's Node.
  - **PowerShell quirks.** `git commit -m` mangled embedded quotes, so I switched to `git commit -F`. `npm.ps1` swallowed `--` arguments, so the seed's confirmation became an environment variable.
  - **Palette.** The first state colours failed a colour-vision check and were re-picked.

## What I cut

- **All stretch ideas.** The brief says the 10 goals are the cutoff and that doing them well beats doing more.
- **Email of any kind** (reminders, password reset): it needs a mail provider and adds no goal.
- **A screen for creating coordinators or changing roles:** coordinators come from the seed.
- **Running the browser end-to-end checks in CI.** They were run from a Playwright script kept outside the repository (it isn't committed) against the production build. CI runs all 265 server tests (integration tests against Postgres plus 14 pure unit tests), the typecheck and the build.
- **Scaling work** I know how to do but didn't need: trigram indexes for search, keyset pagination, caching the alert badge (see [schema.md](schema.md#what-would-break-first-at-100-the-data)).
