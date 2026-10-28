# AI prompts

I built this with **Claude Code** (Anthropic's coding agent, model Claude Opus 5.5) in a single session on 28 October 2026. AI wrote the first draft of nearly all the code, tests and these docs. My part was the decisions put to me, directing the work, and then reviewing and verifying it.

There are two kinds of prompt below:

1. **The prompts I typed** (and my answers to the agent's questions), quoted exactly.
2. **The prompts the agent wrote for sub-agents** during the session (the parallel design review and test-writing). I didn't type these, but they shaped the code as much as anything I did, so they are included, shortened where marked.

Every case where AI output was wrong is recorded with how it was caught and fixed. The commits named are in the history.

---

## 1. Getting started

### Prompt (mine, verbatim)

> read the full folder and make help me make this project and also understand so that i clear this round
>
> *(followed by the pasted email from BUSY Infotech announcing the take-home)*

### What I got

The agent read every file (README brief, SUBMISSION template, the five doc stubs) and checked my machine (Node 22.11, Docker installed but not running, GitHub CLI signed in). Instead of picking a stack itself, it asked me three questions, because the brief says to use what I'm most confident in and I'll be questioned on the code.

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
- **The judge found a live bug** in code written meanwhile: the signups-per-week chart's weeks started 11 hours late (see section 5).

### What I corrected

All 16 design changes went into `2f658a9` (and `ec3e568` for the chart). I verified the two database-level proposals myself before adopting them: the commit-time count trigger and the composite foreign key that keeps the copied time window in sync. The rejected items were mostly already handled (email case normalisation, cancel visibility order). The document-only items became [decisions.md](decisions.md) entries and its interpretations table.

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

The agents also listed about 40 spec questions (ambiguities in the brief).

### What I corrected

The tests were committed exactly as written, failing (`adee245`), and the bugs were fixed in the next commit (`a29554b`). One test was tightened rather than loosened: it now asserts each specific reason a dismissal is refused. The spec questions fed the interpretations table in [decisions.md](decisions.md#interpretations-of-the-brief).

---

## 6. Documentation

### Prompt

The agent drafted these five docs from the session's actual history. A separate fact-checking pass compared every concrete claim (file names, numbers, rules, commit ids) with the code.

### What I corrected

_To fill in after my review: what I rewrote in my own words, and anything I'd decide differently._

---

## What I did myself

_To fill in honestly: which parts I read line by line, what I changed, what I tested by hand on the live site, and what I would still need to ask about._
