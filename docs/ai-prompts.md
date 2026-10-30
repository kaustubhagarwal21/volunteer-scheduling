# AI prompts

I built this with **Claude Code** (Anthropic's coding agent, model Claude Opus 5.5) in a single session on 28 October 2026. AI wrote the first draft of nearly all the code, tests and these docs. My part was the decisions put to me, directing the work, and then reviewing and verifying it.

There are two kinds of prompt below:

1. **The prompts I typed** (and my answers to the agent's questions), quoted exactly.
2. **The prompts the agent wrote for sub-agents** during the session (the parallel design review and test-writing). I didn't type these, but they shaped the code as much as anything I did, so they are included, shortened where marked.

Every case where AI output was wrong in a way that changed the design or the code is recorded with how it was caught and fixed. Quick slips, such as a test expecting the wrong Postgres error text, are not. The commits named are in the history.

---

## 1. Getting started

### Prompt (mine, verbatim)

I've got BUSY Infotech's take-home #18 (their email is pasted below). The folder has the brief
(README.md), the SUBMISSION.md template and five doc stubs in docs/.

1. Read every file first. Then ask me the choices that are mine to make (the stack, how the
   server talks to the database, how to pace the work), each with your recommendation.
2. Build the whole app so it meets all 10 goals. Commit after each meaningful step, with a
   message that says what changed and why.
3. Put the rules that protect the data (no over-filling, no double-booking, a history nobody can
   edit) in the database where you can, and test every rule against a real Postgres, including
   simultaneous requests.
4. Have separate agents attack the design while you build, and apply what holds up. When the
   features are done, have other agents write extra tests against the brief's exact rules.
   None of them may change the code. Record what they found and how it was fixed.
5. Prepare it for free hosting, with CI. I'll do the deployment myself.
6. Then fill in SUBMISSION.md and the five docs from what actually happened, including each time
   your output was wrong in a way that changed the design or the code. Keep secrets out of the repo.
7. Finally, walk me through the code and give me a study guide, because in the follow-up call I
   must explain every decision and commit myself.

[the pasted email]



### What I got

The agent read every file (the brief, then README.md and now [docs/brief.md](brief.md); the SUBMISSION template; the five doc stubs) and checked my machine (Node 22.11, Docker installed but not running, GitHub CLI signed in). Instead of picking a stack itself, it asked me three multiple-choice questions, each with an option it marked as recommended (I chose the recommended option all three times), because the brief says to use what I'm most confident in and I'll be questioned on the code.

### My answers

- *Which stack can you explain line-by-line?* → **TypeScript: React + Express + Postgres**
- *How should the backend talk to the database?* → **Plain SQL + migrations** (rather than an ORM)
- *How should we pace the build and git history?* → **Build all, commit each step**, then a walkthrough and a study guide

### What I corrected

Nothing at this stage. The questions were the right ones to ask before writing code.

---

## 2. Proving the schema before building on it

### Prompt (the agent's own step)

After drafting `001_init.sql`, the agent wrote a probe script that tries every rule the schema claims to enforce, and ran it against Postgres 17 in Docker: set the state by hand, over-fill, double-book, rewrite history, hard-delete a shift with history, generate into an occupied slot.

### What I got

All 11 probes behaved as intended (output recorded in the session). One later probe was **wrong**: a trigger function written as `CASE TG_TABLE_NAME WHEN 'shifts' THEN NEW.id ELSE NEW.shift_id END` failed with *record "new" has no field "shift_id"*, because PL/pgSQL type-checks both branches.

### What I corrected

Rewrote it with `IF ... ELSE` before it went into the migration. It's the version in `001_init.sql`.

---

## 3. Independent design review (sub-agent prompts)

### Prompt (written by the agent for 5 reviewers and 1 judge; shortened)

Shared context given to every reviewer:

> You are reviewing the DESIGN (no application code exists yet) of a take-home hiring project. Read the brief (the 10 numbered goals are the requirements; their exact rules matter more than the headlines), the design draft, and the schema migration… You may verify SQL claims against a real PostgreSQL 17 running in Docker… Report only concrete, actionable findings — no generic advice. Quote the brief sentence or the SQL/design line each finding is about.

Each reviewer then got one lens:
- **literal compliance:** walk goals 1–10 sentence by sentence;
- **state machine, concurrency and data integrity:** find interleavings that corrupt data, and run two psql sessions to prove it;
- **authentication, authorisation and data exposure;**
- **dates, times and recurrence;**
- **interview defensibility and simplicity:** what a sceptical senior engineer would push on.

The judge's prompt:

> Reviewers over-report: many findings are already handled by the design, are not actually required by the brief, or are wrong about Postgres behaviour… try hard to REFUTE it… Default to "reject" when the design already handles it or the brief does not require it.

### What I got

36 merged findings: 16 *change the design*, 14 *document only*, 6 *rejected*. The important ones:

- **A real race (blocker):** a volunteer removed from a program at the same moment as they sign up could keep a future signup. A reviewer proved it with two concurrent psql sessions.
- **Alerts were coordinator-only** in my design, but the brief says *"Anyone should be able to see which shifts are short-staffed"*. All five reviewers flagged this independently.
- **Dismissed alerts came back on more triggers than the brief allows** (headcount edits, reschedules). The brief names only a cancellation.
- **"Signups made" counted only still-active signups**, so later cancellations would rewrite past weeks.
- **Archiving could strand volunteers' upcoming signups**, hidden from them but still blocking their other bookings.
- **A deleted shift's timeline would become unreadable.**
- **The judge found a live bug** in code written meanwhile: the signups-per-week chart's weeks started 11 hours late (see 4c).

### What I corrected

The design changes to code that already existed went into `2f658a9`. The rest were built in from the start in `11f6823` (alerts for everyone, "signups made" counting later-cancelled signups, the archive refusal), `315635a` (a reseedable demo) and `adee245` (the authorization matrix), and `ec3e568` fixed the chart. Before the two database-level proposals were adopted (the commit-time count trigger and the composite foreign key that keeps the copied time window in sync), the agent re-ran each against Postgres 17. The rejected items were mostly already handled (email case normalisation, cancel visibility order). The document-only items became [decisions.md](decisions.md) entries and its interpretations table.

---

## 4. Building: where the AI's own code was wrong

These are cases where code the agent wrote was wrong, how each was caught, and what changed.

### 4a. Per-connection time zone (wrong approach, reversed)

- **Got:** `pool.on('connect', c => c.query("SELECT set_config('TimeZone', ...)"))`, so SQL could use `CURRENT_DATE`.
- **Caught by:** the first test run printed a pg deprecation warning (queueing a query on a busy client goes away in pg 9). Separately, Neon's pooler doesn't keep session settings.
- **Corrected:** an explicit `orgClock()` whose values are passed into queries (`636c2c2`, [decisions.md](decisions.md#decision-7-time-is-an-input-computed-once-per-request)).

### 4b. Overlapping signups sometimes returned 500 (deadlock)

- **Got:** signup code relying on the `EXCLUDE` constraint as the race backstop.
- **Caught by:** the agent's own concurrency test failed about 1 time in 12. A 60-iteration stress loop reproduced it (5/60) and printed Postgres' `deadlock detected ... while checking exclusion constraint`.
- **Corrected:** a per-volunteer advisory lock before the overlap check. 180 stress races then passed, and the regression test repeats the race 20 times (`77dcb9d`).

### 4c. Chart weeks shifted by the UTC offset

- **Got:** `generate_series(date, date, interval)` for the week buckets.
- **Caught by:** the design-review judge, reading the code while it was being written.
- **Corrected:** weeks built as plain dates, converted explicitly (`ec3e568`).

### 4d. The first colour palette failed a colour-vision check

- **Got:** Open = `#b42318`, Partially filled = `#b54708`.
- **Caught by:** running a palette validator. ΔE 6.1 between them is below the floor of 15, so they're hard to tell apart even with full colour vision.
- **Corrected:** status red, amber and green plus slate (passes), with text labels on every use (`31e8be9`).

### 4e. The seed's safety flag silently disappeared on Windows

- **Got:** `npm run seed -- --yes-wipe-remote`.
- **Caught by:** testing the guard against a fake remote host: the flag never arrived, because PowerShell's `npm.ps1` wrapper consumes `--`.
- **Corrected:** an environment variable, `ALLOW_REMOTE_RESET=yes` (`6440f8e`).

### 4f. Smaller ones

- **`git commit -m` with quotes:** a here-string containing quotes broke under PowerShell 5.1. Commit messages now go through `git commit -F file`.
- **Browser check script:** the first end-to-end script read a stale toast and opened the wrong shift. These were bugs in the check, not the app; fixed and re-run, and all 7 checks pass.
- **Seed realism:** the first seed put signups at 3 am and left "shifts closed this week" at 0. Fixed before committing the seed.

---

## 5. Verification: test agents (sub-agent prompts)

### Prompt (written by the agent for 6 test writers; shortened)

> You are writing integration tests for an Express 5 + TypeScript + PostgreSQL app… The requirements are the 10 numbered goals in README.md — their exact rules matter.
> HARD RULES — Write ONLY your own new test file(s)… Do NOT edit anything under server/src… Use YOUR OWN test database… If a test fails, decide honestly: test mistake (fix your test) or app bug / spec gap (KEEP the failing test unchanged so it documents the bug, and report it with evidence). Never weaken an assertion just to make it pass.

Each agent owned one area: an authorization matrix (goal 1), programs and membership (2, 5), the finder (6), generation and the roster CSV (7), the dashboard (8), and timeline and alerts (9, 10).

### What I got

220 tests, of which 210 passed. The 10 failures traced to **4 real bugs**:

- **Existence leak:** a volunteer got a different 404 message for "exists in another program" than for "doesn't exist", which leaked which ids exist.
- **Out-of-range dates:** years 0000 and 3026 (a typo) passed validation and caused 500s.
- **NUL in search:** a NUL character in search text caused a 500.
- **Off-by-one:** the 366-day generation limit allowed 367 days.

The agents also listed 48 spec questions (ambiguities in the brief).

### What I corrected

The tests were committed exactly as written, failing (`adee245`), and the bugs were fixed in the next commit (`a29554b`). One test was tightened rather than loosened: it now asserts each specific reason a dismissal is refused. The spec questions fed the interpretations table in [decisions.md](decisions.md#interpretations-of-the-brief).

---

## 6. Documentation

### Prompt

The agent drafted these five docs from the session's actual history. A separate fact-checking pass compared every concrete claim (file names, numbers, rules, commit ids) with the code.

### What I corrected

I rewrote the "What would you do next" section of SUBMISSION.md in my own words.

---

## What I did myself

- **Decided** the three things put to me at the start (section 1): the stack, plain SQL with migrations instead of an ORM, and building with a commit after each step. I also approved publishing the repository on GitHub.
- **Set up the database:** created the Neon database. I pasted its connection string into the chat so the agent could seed it, so that password needs to be reset after the review.
- **Deployed it on Render:** Render couldn't see the repository at first, so I gave Render's GitHub app access to it, created the Blueprint from `render.yaml`, and pasted `DATABASE_URL` (ending in `sslmode=verify-full`) into Render's settings myself.
- **Tested the live site:** went through the "Try this" steps in SUBMISSION.md as coordinator and as volunteer, and registered a new volunteer account and tested it. I raced two volunteers for the last spot on a shift from two browser windows: one got the spot and the other was refused because the shift was full. I also watched the browser's Network tab while changing the shift filters: every change sent a new request to `/api/shifts`, so the filtering happens on the server. The demo data was reseeded afterwards, so reviewers see it unchanged.
- **Read** the code and these docs, with a walkthrough of the code and an interview study guide.
- **Still want to go deeper on:** the database rules that stop double-booking and over-filling: the row locks, the exclusion constraint and the triggers.

---

## What I'd do differently next time

If I started again, this is the prompt I would give. It was not used for this build.

```text
Build the complete project described in @README.md, following the rules in @CLAUDE.md. Work in the stages below, in order. After each numbered step: run lint, typecheck and tests, show me the real output, then commit with a conventional message and goal tag (e.g. "feat(signups): reject overlapping signups across programs [G4]"). Never squash, amend, rebase or force-push.

Whenever there is a real choice or the brief is ambiguous, STOP and ask me with 2-3 options and trade-offs. Don't decide for me. After I answer, remind me to run /decision. Never write reasons into docs/decisions.md that I didn't give.

My strongest languages/frameworks: <FILL IN>. Use PostgreSQL. Propose a stack that fits these and ask me to confirm before Stage 1.

STAGE 1 - Foundations
1. Draft docs/plan.md: six sessions, goals per session, estimate in hours, risks, why this order. Leave an empty "Actual" column.
2. Design the schema and show it to me before writing migrations. Requirements:
   - Fill state (open / partially_filled / filled) is derived from active signups vs required headcount and can never be set by hand.
   - Signups can never exceed headcount, even under simultaneous requests. One active signup per volunteer per shift.
   - A volunteer can't hold signups for overlapping shifts in ANY program (overlap: a.start < b.end and b.start < a.end; back-to-back is allowed; shifts may cross midnight).
   - Append-only shift_events table; UPDATE and DELETE on it must fail at the database level. Deleting a shift must not delete its history.
   - Alert dismissals stored; whether an alert shows is derived.
   - One org timezone.
   Write docs/schema.md: tables, columns, types, one-to-many vs many-to-many, which rules live in the DB vs the app, what's denormalised.
3. Scaffold: server + web, lint/format/typecheck, .env.example (never touch .env), SQL migrations, a clock module (domain code gets "now" only from it, tests can freeze it), GET /health, integration tests against a real Postgres, a pre-commit hook, GitHub Actions CI with a Postgres service.
4. Prepare deployment on free tiers (propose: Neon + Render + Vercel with /api proxied through the frontend, or a single Render service; let me choose). Add a "waking the server" banner for cold starts. Give me click-by-click dashboard steps; I enter all secrets myself and never paste them here.

STAGE 2 - Goals 1, 2, 5 (tests first, one test per rule, named after the rule)
- Email + password login, hashed passwords, generic error on bad credentials. Roles: coordinator and volunteer.
- Coordinators: create/edit/archive/restore programs, create/edit/delete shifts, add/remove members, sign up or cancel any volunteer, close shifts.
- Volunteers: sign up/cancel only themselves, only in programs they belong to, and only see their programs. Everything enforced on the server with { code, message } errors; the UI only hides what the server already refuses.
- Archiving hides a program from default views without destroying anything.
- Membership is many-to-many; only coordinators manage it; a volunteer sees one list of all their programs and their shifts.
- Generate docs/permissions.md (endpoint x role -> status) and curl commands proving server-side enforcement in docs/architecture.md.
- Ask me: 404 vs 403 for non-members; signups on archived programs; duplicate membership; removing a member who has future signups.

STAGE 3 - Goals 3, 4, 9
- Shift: program, date, start time, duration, location, required headcount. Opening a program shows its shifts.
- Write the state machine table (action x state -> result or error) into docs/architecture.md first.
- One domain service; each action in one transaction: lock, check rule, write, re-derive fill state, append timeline events.
- Signup only when Open or Partially Filled, never Filled or Closed, never overlapping another of the volunteer's signups. Cancel by the volunteer or a coordinator re-derives state. Coordinator closes a shift only after its scheduled time has passed; Closed locks signups and cancellations. Every other move is rejected with a clear message.
- Timeline per shift: created, every fill-state change (old -> new), every signup and cancellation with who did it, coordinator notes. Nothing editable or deletable, by anyone.
- Concurrency tests: 10 simultaneous signups for 3 spots -> exactly 3 succeed; one volunteer signing up for overlapping shifts in two programs at once -> exactly 1 succeeds. Run them 20 times.
- Ask me: actions after a shift starts but before close; lowering headcount below current signups; editing a shift so it now overlaps; editing a Closed shift; deleting a shift with signups.
- UI: shift lists with "2 of 3 filled" and a text fill-state badge; coordinator and volunteer actions; shift page with timeline and notes; errors shown inline.

STAGE 4 - Goals 6, 7
- GET /shifts across every program the viewer can see: text search over program name and location (escape % and _), filters for program, fill state and date range, sort by date, start time or fill state (whitelisted, tie-break on id), pagination returning the total. All in SQL. UI keeps state in the URL and shows "21-40 of 137".
- Recurring generator: date range, weekday, start time, duration, location, headcount, excluded holiday dates, dry run. Report created shifts and skipped dates with reason (holiday or already_exists). All-or-nothing; unique index prevents duplicates. Ask me for a range limit.
- Roster CSV per program: each volunteer with total hours from active signups. Proper escaping, formula-injection guard, UTF-8 BOM. Ask me what counts as hours.

STAGE 5 - Goals 8, 10
- Dashboard: shifts this week, open shifts this week, signups made this week, shifts closed this week; breakdown by fill state and by program; signups per week for the last 8 weeks (empty weeks = 0). Confirm the definitions with me first. Tests use a frozen clock.
- Understaffed alerts: shift date within the next 3 days and Open or Partially Filled. Coordinators can dismiss. If a cancellation later drops a Filled shift back to Open or Partially Filled within those 3 days, the alert returns. Count badge in the navigation. Derive alerts from current state + timeline + dismissals, no stored flags. Ask me the edge cases.
- Idempotent seed script relative to today: 2 coordinators, 10 volunteers, 4 programs (1 archived), shifts from 8 weeks ago to 6 weeks ahead created through the real generator and domain service, understaffed shifts in the next 3 days, one dismissed alert, one Filled shift ready to demo the alert returning. Put demo credentials in SUBMISSION.md. Ask me before seeding the deployed database.

STAGE 6 - Finish
- Self-audit: docs/traceability.md mapping every rule in the brief to the code or constraint enforcing it, the test proving it, and where to see it in the UI. List gaps, then fix each with a failing test first.
- Generate 100x data locally, run EXPLAIN ANALYZE on the shift search, dashboard, alert count and roster, and write the real findings into docs/schema.md.
- Complete docs/architecture.md, schema.md, plan.md, decisions.md and ai-prompts.md so each stub question is answered. Ask me for actual times and which AI outputs were wrong; don't invent either.
- Complete SUBMISSION.md: live URL, repo URL, demo credentials per role, the cold-start note, a 5-minute reviewer tour, known limitations, what I'd do next. Claim nothing the tests don't prove.

Start now with Stage 1, step 1, then stop and wait for me.
```
