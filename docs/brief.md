# Assignment 18 — Volunteer Scheduling

## The scenario

Picture a community organization running a handful of ongoing volunteer programs — a food pantry, a
weekend trail cleanup, a tutoring drive — each needing a certain number of people on-site for specific
shifts throughout the week. Right now shifts get organized over a group chat and a shared spreadsheet:
a coordinator types up which shifts still need people, volunteers reply to claim one, and someone has
to reconcile the replies against the sheet before anyone actually knows who is showing up when.

The result is predictable. Two volunteers both reply claiming the same shift, and nobody notices the
double-booking until they both turn up. A volunteer already committed to a shift for one program signs
up for an overlapping shift in another program, and one of the two goes unstaffed. A shift is one
person short with two days to go and nobody notices, because the only way to check is to count replies
in a chat thread by hand.

They want one system: coordinators set up programs and their shifts, volunteers claim the shifts they
can work, and how many spots are still needed is always a live count, never a guess pulled from a chat
thread. Anyone should be able to see which shifts are short-staffed with days to go, without counting
replies by hand. That is the system you are building.

## What it must do

Everything below is required. Several of the ten spell out exact rules — what happens on an illegal
move, what a bulk action must report back, when a dismissed alert is allowed to reappear — and those
specifics are the actual ask, not just the bold headline in front of them.

1. **Accounts and roles.** People sign in with an email and password, and there are at least two
roles — a coordinator role and a volunteer role. Coordinators create and archive programs, create,
edit and delete shifts, add or remove volunteers from a program, and can sign up or cancel any
volunteer for any shift. Volunteers can sign themselves up for a shift in a program they belong to and
cancel their own signups, but cannot create programs or shifts, add anyone to a program, or act on
another volunteer's signup, and only see programs they belong to. The difference must be enforced on
the server, not just hidden in the interface.

2. **Programs.** Coordinators create programs with a name and a description, and can edit them later.
Programs can be archived and restored. Archiving hides a program from the default views without
destroying its data or its shifts.

3. **Shifts inside programs.** Every shift belongs to exactly one program and carries a date, a start
time, a duration, a location, and a required headcount — the number of volunteer signups it needs.
Shifts can be created, edited, and deleted by coordinators. Opening a program shows its shifts.

4. **A shift lifecycle with rules.** Each signup links one volunteer to one shift, created by that
volunteer for themselves or by a coordinator on their behalf, and a shift moves through
*Open → Partially Filled → Filled → Closed*. Its three fill levels — Open, Partially Filled and
Filled — are derived from its signup count against its required headcount and can never be set by
hand: zero signups leaves it Open, some but fewer than required makes it Partially Filled, and
reaching the required headcount makes it Filled. A signup can only be created for a shift that is
Open or Partially Filled, never for one that is Filled or Closed, and never for a shift whose date
and time window overlaps another shift the same volunteer already holds a signup for. Either the
volunteer or a coordinator can cancel a signup, which lowers the count and re-derives the fill
state. Once a shift's scheduled time has passed, a coordinator closes it, moving it to Closed and
locking out any further signups or cancellations. Any other move must be rejected by the server with
a message explaining why.

5. **Program membership.** A volunteer must belong to a program before they can sign up for any of its
shifts, and a volunteer can belong to any number of programs while a program can have any number of
volunteer members. Only a coordinator can add or remove a volunteer from a program. Every volunteer can
see one list of every program they belong to and every shift within them.

6. **Finding shifts.** One list shows shifts across every program the viewer can see, with a text
search over program name and location, filters for program, fill state and date, sorting by date,
start time or fill state, and pagination showing the total number of matches. All of this must happen
on the server — do not load every shift into the browser and filter there.

7. **Generating a recurring schedule.** A coordinator can bulk-create shifts for a program across a
date range from a recurring weekly pattern — the same day of week, start time, duration, location and
required headcount repeated each week — optionally excluding specific dates as holidays. The result
reports which shifts were created and which dates were skipped, either because they were excluded as a
holiday or because a shift already existed for that program at that date and time. Separately, export
the roster — every volunteer with the total hours from their signups across the program — as a CSV
file.

8. **A dashboard.** A landing view shows headline numbers — shifts this week, open shifts this week,
signups made this week, and shifts closed this week. It also breaks shifts down by fill state and by
program, and charts signups per week over the last eight weeks.

9. **History you cannot rewrite.** Every shift has a timeline showing when it was created, every
fill-state change with the old and new state, every signup and cancellation with who made it, and any
notes coordinators leave on it. Nothing in this timeline can be edited or deleted after the fact,
including by coordinators.

10. **Understaffed shift alerts.** A shift whose date is within the next three days and whose fill
state is still Open or Partially Filled counts as understaffed, and appears in an alerts area, with a
count badge visible in the navigation. A coordinator can dismiss the alert. If a cancellation later
drops a Filled shift back to Open or Partially Filled while its date is still within three days, the
alert returns.

## Stretch ideas (optional)

None of these are required, and none substitute for a goal above. If you finish all ten with time left
over, pick whichever of these sounds most useful and build it:

- Automated reminder messages to volunteers before their shift.
- A waitlist for shifts that are already Filled.
- Volunteer availability preferences used to suggest shifts.
- Group or team signups covering a single shift.
- A public signup page for prospective volunteers.
- Hour-based recognition milestones for long-time volunteers.
- Mobile check-in at the start of a shift.
- Substitute requests when a volunteer can no longer make a shift.
- Multi-language shift descriptions.


---

## What we are assessing

A working application is table stakes. Almost every serious candidate will produce something that runs, has a login, and roughly does what was asked. That's the floor, not the differentiator.

What actually separates submissions is the record of thinking behind the app: the decisions you made and why, the trade-offs you weighed, what you built first and what you deliberately left out, and whether you can explain any part of your own system when asked. We are hiring for judgement. The app is the evidence for that judgement, not the deliverable in itself.

We also read the code itself for structure and readability, which counts for a small share of the overall score.

## Time budget

Budget about 12 hours total, spent roughly 2 hours a day across a week.

This is not a race. We are not timing you against other candidates, and submitting early scores nothing extra. Twelve hours is a size guide so you know how much to attempt — pace yourself, stop when you're tired, and spend some of that time thinking and documenting, not only typing code.

## Pick any stack you like

Use any language, any framework, any UI library, any ORM, and any database access approach you want. We have no house stack, and no stack scores better than another — this round is not a test of whether you know particular tools.

Use whatever you are fastest and most confident in. Time spent learning something new to impress us is time not spent on the ten goals above, and it will show.

## Using AI is allowed and encouraged

Use AI tools however you want — to scaffold code, debug a stuck problem, write tests, draft documentation, or anything else that helps you move faster. A few things to know about how we treat it:

- We do not penalise AI use, and we make no attempt to detect it.
- We care about whether you understood, directed and verified the output — not about who or what produced the first draft of it.
- `docs/ai-prompts.md` must contain the prompts you actually used, including the ones that produced bad output and what you changed afterwards. If you used no AI at all, say so here and describe how you worked instead — that is assessed the same way.
- Submitting generated code you cannot explain is the single most common way candidates fail this round.

You are accountable for everything in your submission. If a reviewer points at a piece of code and asks why it's there, or why it works the way it does, "the AI wrote it" is not an answer.

## Use git properly

Publish to a public GitHub repository, and commit incrementally as the work actually happens — after each meaningful step, not in one pass at the end.

A repository whose entire history is a single "initial commit" containing a finished app scores zero on git history, and it colours how we read everything else in your submission, however good the app itself is. Your history is how we see the order you built in, where you got stuck, and how the design changed along the way. If it isn't there, we can't assess it, and we won't assume the best.

## What you must commit

Alongside your code, commit these five files under `docs/`. Your zip includes a stub for each with the questions it needs to answer — fill them in as you go, not from memory at the end.

| File | What it must answer |
|------|----------------------|
| `docs/architecture.md` | What the moving pieces are, how they talk to each other, where each one runs, the request path for one representative user action end to end, and what you decided not to build. |
| `docs/schema.md` | Every table's columns and types, which relationships are one-to-many versus many-to-many, which constraints live in the database versus the application, what you deliberately denormalised, and what would break first at 100x the data. |
| `docs/plan.md` | How you split the work into sessions, what order you built in and why, what you estimated versus what it actually took, and what you cut when you ran short. |
| `docs/decisions.md` | At least five real decisions — what you chose, what you rejected, and why — including at least one you later reversed. |
| `docs/ai-prompts.md` | The prompts you actually used, in order, grouped by what you were trying to do, including at least one that produced something wrong and what you did about it. |

## Host it for free

Deploy the whole thing somewhere reachable by URL, using free tiers only.

One combination that works, if you would rather not decide:

- **Database** — a managed service such as Supabase.
- **Server-side code** — Render.
- **Browser-side code** — Vercel.

Deploy in that order: create the database first, give the server its connection details as environment variables, then point the browser-side part at the server's public URL.

This is one option, not a requirement. Any free host is equally acceptable — everything on a single provider, one virtual machine, a container platform, a static host with serverless functions. The choice earns and loses nothing.

Requirements:

- A working live URL.
- Seeded with enough demo data to show the system doing something, not an empty shell.
- Demo credentials for every role recorded in `SUBMISSION.md`.
- Connection strings, keys and passwords kept in environment variables, never in the repository.
- Free tiers often sleep when idle and can take a minute or more to wake. Note it in `SUBMISSION.md` if yours does, so a slow first load is not read as a broken deployment.
- If you cannot get it hosted, submit anyway and record in `SUBMISSION.md` what you tried and where it broke.

## How to submit

Send us:

- The URL of your public GitHub repository.
- The URL of your live, deployed application.
- Your completed `SUBMISSION.md`, committed to the repository.

That's the whole submission. Nothing else to prepare, no separate form.

## What happens next

If your submission clears the bar, we'll set up a short call. We will ask about specific decisions we can see in your repository and its history — why you modelled something a particular way, what a certain commit was fixing, what you'd change if you kept going.

We're telling you this now because it should change how carefully you document as you go. Write `docs/decisions.md` for a version of yourself who has to explain it three weeks from now.

## Scope

The 10 goals stated in this brief are the cutoff. Meet all 10, solidly, and you have a complete submission.

Stretch ideas are optional. They exist for candidates who finish the 10 with time left and want to keep building — they are never required, and they do not make up for a goal you didn't hit. Doing 8 goals well beats doing 10 goals badly. If time is short, finish fewer goals properly rather than leaving all ten half-done.
