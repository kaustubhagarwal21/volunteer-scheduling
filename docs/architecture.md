# Architecture

## The moving pieces

There are three, and only one of them makes decisions:

| Piece | What it is | Its job |
|---|---|---|
| **Browser app** | React 19 single-page app (Vite build, React Router, TanStack Query, Tailwind) | Shows data and sends the user's intent. It hides buttons that would fail, but it is never trusted to enforce anything. |
| **API server** | Express 5 on Node 22, TypeScript, plain SQL through `node-postgres` | Owns every rule: who may do what, the shift lifecycle, the alert window, the timeline. Each change to programs, shifts, signups or alerts is one database transaction. |
| **Database** | PostgreSQL 17 | The source of truth, and the last line of defence: the rules that must never break are also constraints, so a bug in the server can't break them either (see [schema.md](schema.md)). |

How they talk:

- Browser → API: JSON over HTTPS to `/api/*` on the **same origin** as the page. The session is an `httpOnly`, `SameSite=Lax` cookie the browser sends automatically. State-changing requests must carry `Content-Type: application/json` (a second CSRF guard; see below).
- API → database: a `pg` connection pool. All SQL is parameterised. Every multi-step change to programs, shifts, signups or alerts runs in `withTransaction` (BEGIN/COMMIT/ROLLBACK); registration and sign-in write their user and session rows as separate statements.
- Nothing else: no queue, no cache, no background worker. Alerts and dashboard numbers are computed by queries when asked, which keeps them always correct and means there is no job that can fall behind or fail silently on a free host that sleeps.

```
            same origin (https://<app>.onrender.com)
 ┌──────────────┐   GET /, /assets/*   ┌──────────────────────────────┐   SQL (TLS)   ┌───────────────┐
 │   Browser    │ ───────────────────► │  Render web service (Node)   │ ────────────► │ Neon Postgres │
 │  React SPA   │ ◄─────────────────── │  Express: /api/* + static    │ ◄──────────── │  (free tier)  │
 └──────────────┘   /api/* JSON +      │  SPA files from client/dist  │               └───────────────┘
                    session cookie     └──────────────────────────────┘
```

## Where each piece runs

- **Production:** one free **Render** web service runs `npm start` (which runs `node dist/index.js` in the server workspace). Express serves the API under `/api` and the built React app (`client/dist`) for every other path, with a history fallback to `index.html`. Pending migrations run on every boot, inside a Postgres advisory lock. The database is a free **Neon** Postgres. Its connection string is the `DATABASE_URL` secret in Render's dashboard and is never in the repository ([render.yaml](../render.yaml)). It must be Neon's **direct** connection string, not the pooled `-pooler` one: the migration lock is a session-level advisory lock, and a transaction-mode pooler can run the lock and the unlock on different server connections and leave it held.
- **Local development:** Postgres 17 runs in Docker ([docker-compose.yml](../docker-compose.yml)), the API runs with `tsx watch` on :3000, and Vite serves the app on :5173, proxying `/api` to :3000. That keeps development on one origin too, so cookies behave exactly as in production.
- **CI:** GitHub Actions runs the typecheck, the full test suite against a Postgres service container, and the production build on every push and pull request. A second, optional workflow ([reseed-demo.yml](../.github/workflows/reseed-demo.yml)) wipes and reseeds the live demo database every Monday at 05:00 IST or on demand; it does nothing unless a `DEMO_DATABASE_URL` repository secret is set.

Serving the app and the API from one service was deliberate (see [decisions.md](decisions.md), decision 1): the cookie is first-party, there is no CORS to configure, and it is one deploy. The cost is that the free instance sleeps after 15 idle minutes, so the first page load after a pause takes about a minute.

## One request end to end: a volunteer signs up for a shift

1. **Browser.** On a shift page, Asha clicks *Sign up for this shift*. `useAction` calls `api('POST', '/shifts/42/signups', {})`, which sends `fetch('/api/shifts/42/signups')` with `Content-Type: application/json`. The browser attaches the `sid` cookie.
2. **Express middleware** ([app.ts](../server/src/app.ts)):
   - `helmet` sets the security headers.
   - `express.json` parses the body and `cookie-parser` reads the `sid` cookie.
   - `requireJsonForChanges` refuses non-JSON writes with 415.
   - `requireAuth` hashes the cookie token with SHA-256, joins `sessions` to `users` (role included) and sets `req.user`; without a valid session the answer is 401.
3. **Route** ([shifts/routes.ts](../server/src/shifts/routes.ts)): zod validates `:id` and the body, then calls `signUp(actor, 42)`. Routes contain no business rules; the exceptions are [auth/routes.ts](../server/src/auth/routes.ts) (registration always creates a volunteer) and [users/routes.ts](../server/src/users/routes.ts), which run their own SQL.
4. **Service** ([signups/service.ts](../server/src/signups/service.ts)), in one transaction, taking locks in the documented order (program → membership → shift → volunteer):
   1. Load the volunteer. Lock the shift's **program** row `FOR SHARE`, so an archive can't land halfway through.
   2. Read the **membership** row `FOR KEY SHARE`, so a concurrent "remove member" either waits for this signup and then cancels it, or wins and this request sees no membership. A volunteer who isn't a member gets a 404 (the program is invisible to them).
   3. Lock the **shift** row `FOR UPDATE`. A second request for the same shift now waits, so two people can't both take the last spot.
   4. Check the rules in order, each refusal a 409 with a reason:
      - `PROGRAM_ARCHIVED`: the program is archived (only a coordinator gets this far; a volunteer already got the 404).
      - `SHIFT_CLOSED`: the shift is closed.
      - `SHIFT_FILLED`: every spot is taken.
      - `SHIFT_STARTED`: a volunteer acting after the start time.
      - `NOT_A_MEMBER`: the person being signed up isn't in the program.
   5. Take an advisory lock on the volunteer's schedule. Check `ALREADY_SIGNED_UP`, then `SIGNUP_OVERLAP` (the message names the clashing shift).
   6. `INSERT` the signup, with a copy of the shift's time window. Write a `signup_created` event.
   7. `UPDATE shifts SET signup_count = signup_count + $2, updated_at = now() WHERE id = $1 RETURNING state` (with `$2` = 1, in `adjustSignupCount`). Postgres recomputes the generated `state` column, and the CHECK refuses a count above the headcount. If the state changed, write `state_changed` with the old and new state.
   8. `COMMIT`. The deferred trigger re-counts the active signups and refuses the commit if `signup_count` disagrees. The overlap `EXCLUDE` constraint has already re-checked the time windows.
5. **Response.** `201 {signup: {id}}`. On the client, `useAction` invalidates all queries, so the shift page, the alert badge, "My programs" and the dashboard refetch and agree. On any refusal, the server's message is shown in a toast, e.g. *"This shift overlaps your signup for After-school Tutoring Drive (2026-11-03 16:00–18:00). A volunteer can't be in two places at once."*

Every other change to a shift or its signups follows the same shape: route → validate → service transaction with locks → rule checks → write → timeline events → commit. Program and membership changes have no timeline of their own (only shifts have one), and creating or editing a program is a single statement.

## Time

Shift dates and start times are the organisation's **wall-clock** values (`DATE` + `TIME`, zone `ORG_TIMEZONE`, default Asia/Kolkata). The server answers "what time is it for the organisation?" in one place, [`orgClock()`](../server/src/time/orgClock.ts) (today, now, Monday of this week), at the start of each operation, and passes those values into queries as parameters. Nothing depends on the database session's time zone. (Neon's sessions run in GMT, which would put "today" 5.5 hours off for an Indian organisation.) The browser never works out "today" itself: `/api/auth/me` returns it.

## Security model

- **Authentication.** bcrypt password hashes (cost 10). Opaque 32-byte session tokens, of which only the SHA-256 is stored. Cookies are `httpOnly`, `SameSite=Lax` and `Secure` in production. Logging out deletes the session row. Failed sign-ins are rate-limited per IP (successful ones don't count), and registration is limited separately.
- **Authorisation.** Deny by default: everything after `/api/auth` sits behind `requireAuth`. Coordinator-only routes add `requireCoordinator`. One visibility rule ([programs/access.ts](../server/src/programs/access.ts)) gives volunteers only active programs they belong to; anything else is a 404 with the same message whether or not it exists. Roles are read from the database on every request, so a role change takes effect immediately.
- **Input.** Every body, query and parameter that a route reads goes through zod, and those schemas are strict, so unknown keys are a 400 (routes that take no input, such as close, cancel, archive, dismiss and logout, ignore any body). Trying to set a fill state when creating or editing a shift gets an explanation. Dynamic SQL is assembled only from fixed fragments and `$n` placeholders (`QueryParams`). Sort columns come from a whitelist.
- **CSRF.** `SameSite=Lax` stops browsers sending the cookie on cross-site writes. As a second layer, writes must be `application/json`, which cross-site forms can't send, and no CORS is ever granted.
- **Output.** The roster CSV neutralises spreadsheet formulas. 500s log the message, code and stack, never Postgres' row detail (which can include a password hash).

## Testing

- **265 automated tests** (`npm test`): unit tests for the pure parts (recurrence planner, CSV writer, org clock) and integration tests through the real HTTP stack against real Postgres. The integration tests cover a table-driven authorization matrix, every illegal lifecycle move, concurrency races (the last spot, overlapping signups), the append-only history at the database level, and each goal's exact rules.
- **Browser checks (not in the repository):** before the deployment commit `6440f8e`, the production build was checked in a real browser (Edge, driven by a Playwright script kept outside the repository) for the key flows: overlap refusal, cancel → dismissed alert returns, close.

## What I decided not to build, and why

The brief says the 10 goals are the cutoff and doing them solidly beats breadth, so **none of the stretch ideas** were built. Also left out:

| Not built | Why |
|---|---|
| Email (reminders, password reset, invitations) | Needs a mail provider, verified domain and templates: real infrastructure for no goal. Password reset is the first thing to add in a real deployment. |
| A screen to create coordinators or change roles | Not in the goals, and an easy privilege-escalation surface. Coordinators come from the seed (or one SQL insert); self-registration always creates a volunteer. |
| Real-time updates (websockets) | Not needed for correctness. The badge polls every 60 seconds and every change refetches the page. |
| Background jobs (auto-closing, scheduled alerts) | The brief has a coordinator close shifts. Alerts are computed at query time, which stays correct on a host that sleeps. |
| Per-program time zones | One organisation, one place. The wall-clock model would need a zone column per program. |
| A separate low-privilege database role | Defence in depth for the append-only history. Documented in [schema.md](schema.md); not required by the brief. |
| Shared client/server type package | The client's types (`client/src/api/types.ts`) are kept by hand in step with the server's DTOs. Small API, and a shared package adds build plumbing. |
