# Submission

## Links

- **GitHub repository:** _to be added_
- **Live application:** _to be added_

## Notes for the reviewer

- **The first load can take about a minute.** The app runs on Render's free tier, which sleeps after 15 idle minutes. The page and the API are one service, so the very first request wakes it; after that it's fast. The database (Neon) wakes in about a second.
- **Demo data is relative to the day it was seeded** (alerts look three days ahead; the dashboard shows "this week"). It was last seeded on _date to be added_. If it looks stale, `npm run seed` against the database refreshes it (see "Run it locally").
- **Every refused move explains why.** Try the illegal ones; the server's reason appears as a message at the bottom of the screen.
- Shift times are the organisation's local time (Asia/Kolkata).

## Demo credentials

| Role | Email | Password |
|---|---|---|
| Coordinator | coordinator@demo.org | coordinator123 |
| Volunteer (Asha, in 3 programs) | volunteer@demo.org | volunteer123 |
| Volunteer with no programs yet | newcomer@demo.org | volunteer123 |
| Second coordinator | rahul.coordinator@demo.org | coordinator123 |

All other seeded volunteers (e.g. ben@demo.org) also use `volunteer123`. Anyone can register a new account, which is always a volunteer.

### Try this

| Goal | Try |
|---|---|
| 1 Roles | Sign in as the volunteer: there is no "New program", "Add shift" or "Close". The API refuses those calls too (403), and other programs' shifts are a 404. |
| 2 Programs | Coordinator → Programs → *Archived* tab shows *Monsoon Relief Collection*. Restore it: all its shifts and history come back. Try archiving *Community Food Pantry*: refused while volunteers hold upcoming signups. |
| 3 Shifts | Open a program, *Add shift*; open a shift, *Edit details* or *Delete shift* (deleted shifts stay readable under the *Deleted* tab). |
| 4 Lifecycle | As Asha, *My programs* → the 4:30 pm pantry restock on the same day as her 4:00 pm tutoring session → *Sign up*: refused, naming the overlap. Try a Filled shift you aren't on: no button, and the API says why (Asha is often on every Filled shift she can see; the other volunteers are firstname@demo.org with `volunteer123`). As coordinator, open a finished shift that isn't Closed yet (the seed closes all but the most recent one: *Shifts* → *Include past shifts*, *To date* = today, *Descending*) and *Close shift*: it's locked from then on. |
| 5 Membership | Coordinator → a program → *Members*: add *Nikhil Jain*, then sign in as newcomer@demo.org to see the program appear. Removing a member cancels their upcoming signups there (shown on each shift's history). |
| 6 Finding shifts | *Shifts*: search "library" or "pantry", filter by program, state and dates, sort by date, start time or fill state, page through. All server-side. |
| 7 Recurring + CSV | A program → *Repeat weekly…*: the report lists created dates and skipped ones (holiday / a shift already exists). *Export roster (CSV)* gives every volunteer's hours. |
| 8 Dashboard | The landing page: this week's numbers, signups per week (hover a column, or *Show as table*), and the breakdowns by fill state and by program. |
| 9 History | Any shift page → *History*: creation, every state change (old → new), every signup and cancellation with who made it, notes. The app has no way to edit or delete an entry, and database triggers refuse UPDATE, DELETE and TRUNCATE on the history table (only the role that owns the table could disable them; see item 5 under "What would you do next"). |
| 10 Alerts | The badge on *Alerts*. The Filled **2:00 pm tutoring session** two days after the seed date had its alert dismissed while it was one short. As Asha, cancel her place on it (*My programs* → *Cancel my signup*), or as coordinator open it and *Cancel* any signup: the alert comes back and the badge goes up. |

## Run it locally

Needs Node 22 and Docker.

```bash
npm install
docker compose up -d                  # Postgres 17 on :5433 (dev and test databases)
cp server/.env.example server/.env    # PowerShell: Copy-Item server/.env.example server/.env
npm run seed                          # builds the schema and the demo data
npm run dev                           # API on :3000, app on http://localhost:5173
npm test                              # 265 tests against the volunteer_test database
```

To reseed the deployed database (this wipes it), run `npm run seed` with `DATABASE_URL` set to its connection string and `ALLOW_REMOTE_RESET=yes`. Use Neon's direct connection string (not the `-pooler` one) for both the app and the seed.

## Stack

| Layer | What I used | Why |
|---|---|---|
| Frontend | React 19, Vite 6, React Router 7, TanStack Query, Tailwind CSS 4; charts hand-drawn (an SVG column chart and HTML/CSS bars, no chart library) | Familiar, fast to build; TanStack Query keeps server data fresh after every change |
| Backend | Node 22, Express 5, TypeScript, zod, node-postgres (plain SQL), bcryptjs | Explicit SQL: the key rules are Postgres features (generated column, exclusion constraint, triggers, row locks) |
| Database | PostgreSQL 17 | Generated columns, `EXCLUDE` constraints, deferred constraint triggers, transactional DDL |
| Hosting | Render (one free web service: API + built SPA, same origin) and Neon (free Postgres) | Same origin means a first-party session cookie and no CORS; Neon suspends an idle database but wakes it on the next connection in about a second, and doesn't pause the project or expire like Supabase's and Render's free Postgres |

## Goal checklist

| # | Goal | Status | Notes |
|---|---|---|---|
| 1 | Accounts and roles | Done | Email and password; server-side sessions; deny-by-default auth; an authorization matrix test covers every route signed out and as a volunteer, and every coordinator-only route as a coordinator |
| 2 | Programs | Done | Create, edit, archive and restore; archiving hides without touching data; refused while upcoming signups exist (see decisions) |
| 3 | Shifts inside programs | Done | Create, edit, delete (soft: history kept); opening a program lists its shifts |
| 4 | Lifecycle with rules | Done | Fill state is a generated column; over-filling and double-booking are impossible even under concurrent requests (tested); every illegal lifecycle move (Filled, Closed, overlap, already started, not yet over) is a 409 with a reason, and trying to set the fill state directly is a 400 that explains why |
| 5 | Program membership | Done | Coordinators add and remove; members only; "My programs" is the one list |
| 6 | Finding shifts | Done | Search, filters, three sorts, pagination with total, all in SQL |
| 7 | Recurring schedule + CSV | Done | Report of created and skipped dates (holiday / already exists); roster CSV with total hours |
| 8 | Dashboard | Done | The four headline numbers, breakdowns by state and by program, an 8-week signups chart |
| 9 | History you cannot rewrite | Done | Append-only table enforced by database triggers; no edit or delete endpoints |
| 10 | Understaffed alerts | Done | Badge plus alerts page for everyone; coordinators dismiss; a cancellation out of Filled brings it back |

Interpretations of ambiguous wording are listed in [docs/decisions.md](docs/decisions.md#interpretations-of-the-brief).

## How much time did you actually spend?

The initial build was **one AI-assisted session on 28 October 2026: about 2 hours 20 minutes of building (18:00–20:20 IST), then about 30 minutes for a fact-check of the docs and fixes**, plus one small UI fix at 22:15 (Claude Code, with parallel AI agents for design review and tests; see [docs/plan.md](docs/plan.md) and [docs/ai-prompts.md](docs/ai-prompts.md)). After that, my own time reading and understanding the code, deploying, and rewriting the docs: _to be filled in_.

## What would you do next, with another 12 hours?

1. **Email:** shift reminders the day before, and password reset (both need a mail provider).
2. **A waitlist for Filled shifts** that offers the spot automatically when someone cancels. The cancellation path is already the single place where that would hook in.
3. **Scale the read paths:** trigram indexes for search, keyset pagination, a windowed dashboard (see the 100× section of [docs/schema.md](docs/schema.md)).
4. **Run browser end-to-end checks in CI** (a Playwright script was run by hand during the build, but it isn't in the repository yet).
5. **A low-privilege database role** for the server, so even the app's own credentials can't disable the history triggers.
6. **An accessibility pass** with a screen reader, and a dedicated mobile layout for the shift tables.

## What are you least happy with in this codebase, and why?

- **The client refetches everything after any change.** It's simple and always consistent, but wasteful. Targeted invalidation per query would be better past a few users.
- **Client types are kept by hand** next to the server's DTOs. Nothing fails at build time if they drift; a shared types package (or generating them from the zod schemas) would fix that.
- **`signup_count` is still updated by application code.** The database now verifies it at commit, so it can't drift silently, but there are still two places that know how to count.
- **The dashboard's breakdowns scan every shift on every load.** Fine at this size, and the first thing to change at 100×.
