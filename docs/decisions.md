# Decisions

Each entry is a choice where a real alternative existed. Entries marked **Later reversed** or **Later changed** record what I first did, what changed my mind, and the commit where it happened. The last section lists where I had to interpret the brief.

## Decision 1: One service serves both the API and the web app

- **Chose:** a single Render web service. Express serves `/api` and the built React app from the same origin.
- **Rejected:** the brief's suggested split (React on Vercel, API on Render).
- **Why:** with two origins the session cookie becomes a third-party cookie, which Safari blocks by default. I would then have to move the token into `localStorage` (readable by any XSS) or put a proxy in front. One origin gives a first-party `httpOnly` cookie, no CORS configuration, and one thing to deploy. The cost: the free instance sleeps after 15 idle minutes, and because the page is served by the same service, the very first load also waits about a minute. That is noted in SUBMISSION.md.

## Decision 2: Neon for the database

- **Chose:** Neon's free Postgres.
- **Rejected:** Supabase and Render Postgres.
- **Why:** reviews can happen weeks after submission. Supabase pauses free projects after about 7 days of low activity, and Render's free Postgres expires after 30 days. Either could leave a reviewer looking at a dead link. Neon suspends compute after 5 idle minutes but wakes on the next connection in about a second, and doesn't expire.

## Decision 3: Plain SQL and hand-written migrations, no ORM

- **Chose:** `node-postgres` with parameterised SQL, plus a ~60-line migration runner (files applied in order, each in a transaction, under an advisory lock).
- **Rejected:** Prisma or another ORM.
- **Why:** the most important rules here are database features an ORM doesn't model: a generated column, an `EXCLUDE` constraint, append-only triggers, a deferred constraint trigger, and `SELECT ... FOR UPDATE` locking. With an ORM those would live in raw-SQL escape hatches anyway, and the queries the reviewer asks about would be hidden. The cost is mapping rows to DTOs by hand (`toShiftDto`) and assembling dynamic filters carefully (`QueryParams`, whitelisted sort columns).

## Decision 4: The fill state is a generated column over a stored count, checked at commit

- **Chose:** `shifts.signup_count` (stored) and `shifts.state`, a `GENERATED ALWAYS` column computed from `closed_at`, `signup_count` and `required_headcount`, plus `CHECK (signup_count <= required_headcount)` and a deferred trigger that checks at commit that the count equals the active signups.
- **Rejected:** (a) computing the state on every read with `COUNT(*)`; (b) a status column the application writes.
- **Why:** the brief says the fill states "can never be set by hand". With a generated column, Postgres itself rejects any attempt to write the state. A stored count makes the state indexable and sortable (the finder sorts by it) and gives the over-fill CHECK something to check, so two people can never both take the last spot. Option (b) is exactly the thing the brief forbids, and it can drift.
- **Later changed** (commit `2f658a9`): at first the count was kept right only by application code. The design review pointed out that a forgotten code path (or the seed script) could make it lie. Since then a `DEFERRABLE INITIALLY DEFERRED` trigger re-counts at commit, so even `UPDATE shifts SET signup_count = 2` by hand fails.

## Decision 5: Overlap prevention lives in the database

- **Chose:** an `EXCLUDE USING gist (volunteer_id WITH =, time_range WITH &&) WHERE cancelled_at IS NULL` constraint on signups, which needs a copy of the shift's time window on each signup row.
- **Rejected:** checking overlaps only in application code.
- **Why:** the brief's second failure story is a volunteer double-booked across two programs. Two signup requests for *different* shifts lock different rows, so an application-only check can be raced: both requests check, both pass, both insert. The constraint makes that impossible.
- **Later reversed, twice:**
  1. *The copied window was kept in sync by hand* in the shift-edit code. The design review noticed that a duration-only edit path was easy to miss (I had handled it, but nothing guaranteed it). Since `2f658a9`, a composite foreign key `(shift_id, time_range) REFERENCES shifts (id, time_range) ON UPDATE CASCADE` makes the database keep the copy right, and moving or lengthening a shift re-checks the overlap constraint automatically.
  2. *I assumed the constraint alone handled concurrency.* A test that fires two overlapping signups for one volunteer at the same moment failed about 1 time in 12 with a 500. Postgres reported a **deadlock inside the exclusion check**: each transaction inserts its row, sees the other's uncommitted row, and waits for it. Since `77dcb9d`, signup and reschedule first take a per-volunteer advisory lock (`pg_advisory_xact_lock(1, volunteer_id)`), so the second request waits, sees the first signup, and gets a clear 409. The constraint stays as the final guarantee. 180 stress races passed afterwards, and the regression test repeats the race 20 times.

## Decision 6: Server-side sessions instead of JWTs

- **Chose:** a random 32-byte token in an `httpOnly` cookie, with its SHA-256 stored in a `sessions` table.
- **Rejected:** a signed JWT.
- **Why:** the user's role must be current on every request (a demoted coordinator must lose access immediately), so the server reads the database per request anyway, and a JWT's main benefit (no lookup) disappears. A session row can be revoked: logout really logs out. Storing only the hash means a leaked sessions table can't be replayed as cookies.

## Decision 7: Time is an input, computed once per request

- **Chose:** shift dates and times are the organisation's wall-clock values (`DATE` + `TIME`). `orgClock()` in Node computes today, now and this week's Monday for `ORG_TIMEZONE`, and they are passed into SQL as parameters.
- **Rejected (originally chosen):** setting each database connection's `TimeZone` in `pool.on('connect')` so SQL could use `CURRENT_DATE` and `LOCALTIMESTAMP`.
- **Later reversed** (commit `636c2c2`): two things changed my mind.
  1. node-postgres 8.23 printed a deprecation warning, because queueing a query on a client that is still running one (exactly what that hook does) is removed in pg 9.
  2. The setting only held on connections that ran the hook. A seed or migration script with its own client, a psql session or a different pooler would silently use the database's default zone. Neon's default turned out to be GMT, so "today" would have been 5.5 hours off for an Indian organisation. I also expected Neon's pooled endpoint (PgBouncer in transaction mode) to drop the setting. The design review later showed it wouldn't for `TimeZone`, which PgBouncer tracks per client; my commit message for `636c2c2` overstates that point.

  The explicit clock also made the rule "the browser never computes today" easy: `/api/auth/me` returns the server's today.
- **Related bug found later** (`ec3e568`): the signups-per-week chart still built its weeks with `generate_series` over dates. That silently returns `timestamptz` in the session's zone, so every bucket started at 11:00 IST instead of midnight. The rule now written in the code: a local date becomes an instant only through an explicit `date::timestamp AT TIME ZONE zone`.

## Decision 8: Deleting a shift is a soft delete

- **Chose:** `deleted_at` / `deleted_by`. The shift disappears from every view, its active signups are cancelled (each recorded), and its timeline is kept. Coordinators can still open a deleted shift read-only.
- **Rejected:** a hard delete with cascade.
- **Why:** goal 3 says coordinators can delete shifts, and goal 9 says nothing in a shift's history can be deleted, "including by coordinators". A soft delete satisfies both. The append-only trigger and the foreign key would refuse a hard delete anyway. Shifts that have already started can't be deleted (they are part of the record); a coordinator closes them instead.

## Decision 9: Alerts are a query, visible to everyone, and only a cancellation brings one back

- **Chose:** "understaffed" is computed at query time (Open or Partially Filled, dated today to today+3, not yet started). Each shift has one dismissal (`alert_dismissed_at`). Every signed-in user sees the alerts for the programs they can see; only coordinators dismiss. A dismissed alert returns only when a **cancellation** drops the shift out of Filled.
- **Rejected:** a stored alerts table, or a scheduled job raising alerts. A job falls behind on a host that sleeps; a query is always current.
- **Later reversed** after the design review (point 1 in `11f6823` and `31e8be9`, point 2 in `2f658a9`):
  1. I had made the whole alerts area **coordinator-only** (in the client shell, `1577a9d`). The scenario says *"Anyone should be able to see which shifts are short-staffed"* and the goal restricts only *dismissing* to coordinators, so the alerts area and the badge are now shown to everyone, scoped to their programs.
  2. I had also un-dismissed alerts on *any* drop out of Filled (a headcount increase) and on rescheduling. The brief singles out "when a dismissed alert is allowed to reappear" as one of the exact rules, and the brief names one trigger, a cancellation, so that is now the only one. Tests cover a headcount increase and a cancellation that only takes Partially Filled to Open, neither of which brings an alert back (rescheduling has no such test).

## Decision 10: Who may sign up or cancel, and until when

- **Chose:** volunteers act for themselves until the shift **starts**. Coordinators can sign up or cancel anyone until the shift is **Closed**, so they can record walk-ins and no-shows. Closing locks everyone out.
- **Later reversed** (`2f658a9`): at first nobody could sign up after the start time, while coordinators could still cancel. The review pointed out that this made Close lock nothing for signups and was lopsided (no-shows could be fixed but walk-ins couldn't), and the brief's lock point is Close.

## Decision 11: Archiving is refused while volunteers hold upcoming signups

- **Chose:** archiving only sets `archived_at`, so restoring brings everything back. It is refused (409) while any not-yet-started shift in the program has active signups. Archived programs are frozen until restored: their shifts, notes, signups and members can't change (409 `PROGRAM_ARCHIVED`), though a coordinator can still edit the program's name and description.
- **Rejected:** (a) cancelling those signups automatically: restore couldn't bring them back, and "without destroying its data" argues against it; (b) archiving anyway: the volunteers could no longer see their signups, yet those signups would still block overlapping ones elsewhere.
- **Why:** nothing hidden is left holding a person's time.

## Decision 12: Volunteers get a 404 for other programs, and the same 404 for things that don't exist

- **Chose:** anything outside a volunteer's programs is "not found", never "forbidden", with exactly the same message as for a missing id. The message still explains the rule ("it may belong to a program you are not a member of").
- **Why:** a 403 would confirm the thing exists. **Later changed** (`a29554b`): a test agent found that the two cases had slightly different messages, which leaked whether an id existed. One helper, `notVisible()`, now produces the answer for both.

## Decision 13: Independent AI reviewers and testers that may not touch the code

- **Chose:** after drafting the design, five reviewer agents (literal compliance, concurrency, security, time handling, interview defensibility) attacked it independently, running SQL against a real Postgres, and a judge agent tried to refute each finding before I acted on it. After the features were built, six test agents each took one area of the brief and wrote integration tests against its exact rules, with instructions never to change application code or weaken an assertion.
- **Rejected:** letting the same agent that wrote the code also judge or test it.
- **Why:** a writer's tests share the writer's blind spots. The split found real problems: the membership race, the week-boundary bug, the existence leak, a 500 on a year-0000 date, and an off-by-one in the 366-day limit. The failing tests were committed as written (`adee245`) and fixed separately (`a29554b`), so the history shows what they caught. `a29554b` also rewrote one passing assertion in `alerts.test.ts`, because refused dismissals now name their specific reason.

## Decision 14: Charts drawn by hand (an SVG column chart and an HTML stacked bar)

- **Chose:** two small components: a column chart and a stacked bar.
- **Rejected:** a charting library.
- **Why:** two simple charts don't justify ~100 KB of library. Writing them made the details deliberate: thin marks, gaps instead of borders, hover and keyboard readouts, and a table view. The state colours were checked with a colour-vision validator. The first palette put Open and Partially filled too close together (ΔE 6.1 against a floor of 15), so I switched to status red, amber and green plus slate, and every use carries a text label.

## Interpretations of the brief

Where the brief was ambiguous, this is what the app does. Every row has tests, except that the future-start rule is tested only for generation, not for creating or rescheduling a single shift.

| Brief says | The app does | Why |
|---|---|---|
| "a shift whose date is within the next three days" | Dated today through today+3 (calendar dates in the organisation's zone), and not yet started | "Date" suggests calendar days; once a shift has started, volunteers can no longer sign themselves up (only a coordinator can add a walk-in), so an alert would be noise |
| "Once a shift's scheduled time has passed" | Close is allowed once the shift has **ended** (start + duration) | A shift in progress hasn't "passed" |
| Closed locks "signups or cancellations" | Closed also locks edits and deletion | A closed shift is the record of what happened |
| "this week" | Monday to Sunday in the organisation's zone | ISO week |
| "open shifts this week" | Shifts this week in the **Open** state (no signups); Partially Filled shown next to it | Uses the brief's own state name; the second number covers the other reading |
| "signups made this week" / per-week chart | Every signup **created** in the week, including ones later cancelled, bucketed by when it was made | "Made" is the act; counting this way means a later cancellation never rewrites an old week |
| Breakdown "by fill state and by program" | All live shifts in active programs, past and upcoming (labelled on the page) | The only scope that shows all four states |
| "a shift already existed for that program at that date and time" | Same program, date **and start time** (enforced by a unique index) | Makes generation idempotent and race-free. Trade-off: two shifts at the same start time in one program aren't allowed |
| Generation report | Created shifts plus skipped dates (`holiday` / `already_exists`); excluded dates that never matched the weekday are listed separately | A mistyped holiday shouldn't vanish silently |
| Roster "total hours from their signups" | Active (non-cancelled) signups on live shifts, plus a separate "hours on closed shifts" column; current members and anyone with signups are listed | Total includes booked future hours; the second column shows hours actually done |
| Timeline readers | Anyone who can see the shift, including coordinator notes (the note box says notes are visible to members and permanent) | Transparency; the brief doesn't restrict it |
| Creating shifts | Must start in the future (create, reschedule, generation) | Scheduling is for upcoming work; past shifts can only come from history |
| Who can register | Anyone, always as a volunteer, who sees nothing until a coordinator adds them to a program | Coordinators come from the seed; no privilege escalation through the API |
