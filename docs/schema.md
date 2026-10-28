# Schema

PostgreSQL 17, one migration: [server/migrations/001_init.sql](../server/migrations/001_init.sql). Ids are `INTEGER GENERATED ALWAYS AS IDENTITY`. Timestamps that record *when something happened* are `TIMESTAMPTZ`. A shift's date and start time are the organisation's wall-clock values (`DATE` + `TIME`); the time model is explained in [architecture.md](architecture.md#time).

## Tables

### `users`
| Column | Type | Notes |
|---|---|---|
| id | integer PK | |
| email | text, unique | `CHECK (email = lower(email))`; the API trims and lower-cases it first |
| name | text | not blank |
| password_hash | text | bcrypt |
| role | enum `user_role` ('coordinator', 'volunteer') | default volunteer; self-registration can only create volunteers |
| created_at | timestamptz | |

### `sessions`
| Column | Type | Notes |
|---|---|---|
| token_hash | text PK | SHA-256 of the cookie token; the token itself is never stored |
| user_id | integer → users | `ON DELETE CASCADE` |
| created_at, expires_at | timestamptz | 7-day sessions; logout deletes the row |

### `programs`
| Column | Type | Notes |
|---|---|---|
| id | integer PK | |
| name | text | not blank |
| description | text | default '' |
| archived_at | timestamptz, null | archived ⇔ not null. Archiving touches nothing else. |
| created_by | integer → users | |
| created_at, updated_at | timestamptz | |

### `program_members` (join table)
| Column | Type | Notes |
|---|---|---|
| program_id | integer → programs | PK (program_id, user_id) |
| user_id | integer → users | index on user_id for "my programs" |
| added_by | integer → users | |
| added_at | timestamptz | |

### `shifts`
| Column | Type | Notes |
|---|---|---|
| id | integer PK | |
| program_id | integer → programs | |
| shift_date | date | `CHECK` 2000-01-01..2999-12-31 (rejects `infinity`) |
| start_time | time(0) | `CHECK` whole minutes and `< 24:00` |
| duration_minutes | integer | 15..1440 |
| location | text | not blank |
| required_headcount | integer | 1..500 |
| signup_count | integer | **denormalised** count of active signups; `CHECK (signup_count >= 0 AND signup_count <= required_headcount)` (constraint `shifts_signup_count_within_headcount`) |
| closed_at, closed_by | timestamptz, integer → users | both null or both set |
| deleted_at, deleted_by | timestamptz, integer → users | soft delete; both null or both set |
| alert_dismissed_at, alert_dismissed_by | timestamptz, integer → users | the understaffing alert's dismissal |
| created_by, created_at, updated_at | | |
| **time_range** | tsrange, **generated** | `[date+start, date+start+duration)`: the wall-clock window |
| **state** | enum `shift_state`, **generated** | `closed` if closed_at, else `open` (0 signups), `partially_filled`, or `filled`, from signup_count vs required_headcount |

Indexes: unique `(program_id, shift_date, start_time) WHERE deleted_at IS NULL` (one live shift per slot, and the "already exists" test for recurring generation); `(shift_date, start_time) WHERE deleted_at IS NULL` (finder date filters and sorting, alerts); unique `(id, time_range)`, the target of the signups foreign key below.

### `signups`
| Column | Type | Notes |
|---|---|---|
| id | integer PK | |
| shift_id, time_range | integer, tsrange | composite FK → `shifts (id, time_range) ON UPDATE CASCADE` |
| volunteer_id | integer → users | |
| created_by | integer → users | the volunteer, or the coordinator acting for them |
| created_at | timestamptz | |
| cancelled_at, cancelled_by | timestamptz, integer → users | a cancellation keeps the row; both null or both set |

Constraints: **`EXCLUDE USING gist (volunteer_id WITH =, time_range WITH &&) WHERE (cancelled_at IS NULL)`**, so no volunteer can hold two overlapping active signups. Unique `(shift_id, volunteer_id) WHERE cancelled_at IS NULL`. Indexes on shift_id, volunteer_id and created_at.

### `shift_events` (the timeline)
| Column | Type | Notes |
|---|---|---|
| id | integer PK | the order of the timeline |
| shift_id | integer → shifts | |
| event_type | enum: created, updated, state_changed, signup_created, signup_cancelled, note, alert_dismissed, deleted | |
| actor_id | integer → users | who did it |
| volunteer_id | integer → users, null | whose signup |
| from_state, to_state | shift_state, null | required and different for `state_changed` |
| note | text, null | required for `note` |
| details | jsonb, null | e.g. `{changes: {location: {from, to}}}`, `{source: 'recurring'}`, `{reason: 'removed_from_program'}` |
| created_at | timestamptz | |

Triggers reject every `UPDATE`, `DELETE` and `TRUNCATE` on this table.

### `schema_migrations`
`name text PK, applied_at timestamptz`, maintained by the migration runner.

## Relationships

- **One-to-many:** program → shifts, shift → signups, shift → shift_events, user → sessions, and user → signups (as the volunteer, and as `created_by`).
- **Many-to-many:** volunteers ↔ programs through `program_members` (a volunteer belongs to any number of programs; a program has any number of members). Volunteers ↔ shifts is also many-to-many, through `signups`, which carries its own data (who made it, when, cancellation).

## What the database enforces, and what the application enforces

**The rule I used:** if breaking a rule would corrupt data, or could happen through a race between two requests, the database enforces it. Rules that depend on who is asking, what time it is, or that need a human-readable reason live in the application, which checks most database-enforced ones first anyway (duplicate emails and duplicate memberships are caught by the constraint and translated by the error handler), so users get a specific message instead of a constraint name.

| Rule | Database | Application |
|---|---|---|
| Fill state derived, never set by hand | `state` is a generated column (writing it is an error); a deferred trigger checks at commit that `signup_count` equals the active signups, so the counter can't be faked either | No endpoint accepts a state; a shift create, generate or edit body containing one (or `signupCount`, `spotsLeft`, `closedAt`) gets 400 `FILL_STATE_DERIVED` |
| No over-filling, even with simultaneous requests | `CHECK (signup_count <= required_headcount)` | Shift row locked `FOR UPDATE`; `SHIFT_FILLED` message |
| No overlapping signups for one volunteer | `EXCLUDE` constraint, re-checked automatically when a shift is moved (FK cascade) | Advisory lock per volunteer plus a pre-check that names the clashing shift |
| Signup's window equals its shift's window | Composite foreign key with `ON UPDATE CASCADE` | none needed |
| History can't be rewritten | Triggers block UPDATE/DELETE/TRUNCATE; the foreign key blocks hard-deleting a shift with history | No edit/delete endpoints; deleting a shift is a soft delete |
| One live shift per program, date and start time | Partial unique index | Pre-check with a message naming the slot |
| Valid values (non-blank names, headcount 1..500, sane dates and times) | CHECKs | zod validation with field-level messages |
| Lowercase unique emails | `UNIQUE` + `CHECK` | zod normalises first |
| Only members sign up; volunteers act only for themselves; started/closed cut-offs; archived programs' shifts, signups and members frozen (the program's name and description stay editable); alert window and dismissal rules | none | Service layer, inside the locked transaction |
| Who can see what | none | One rule in `programs/access.ts`, in two forms: `visibleProgramsSql` for list queries and `assertCanView` for single programs, shifts and signups (sign-up repeats the membership check inline under its lock) |

Why the last rows aren't constraints: they depend on the caller (role, membership) or the clock ("has it started", "within three days"). Postgres can't evaluate those in a CHECK, and putting them in triggers would hide them from anyone reading the routes.

## What was deliberately denormalised

1. **`shifts.signup_count`.** It could be `COUNT(*)` of active signups every time. It's stored so the fill state can be a generated column that queries filter and sort on directly (it could be indexed, though no index on `state` exists yet), and so the over-fill CHECK has something to check. The cost, keeping it in sync, is paid in two places, both under the shift's row lock: `adjustSignupCount` (every signup and cancellation) and `deleteShift`, which sets it to 0 after cancelling the shift's signups. The commit-time trigger verifies both.
2. **`signups.time_range`.** A copy of the shift's window, because an `EXCLUDE` constraint can only see columns of its own table. The composite foreign key with `ON UPDATE CASCADE` makes the database keep the copy in sync.
3. **`shifts.state` and `shifts.time_range`.** Generated (derived) columns, stored so they can be indexed and sorted without repeating the expressions in every query.
4. **Alert dismissal on the shift row** (`alert_dismissed_at/by`) rather than a separate alerts table. There is at most one live alert per shift, so a separate table would add a join for no benefit. The history of dismissals is in `shift_events`.

## What would break first at 100× the data

The seed has about 70 shifts and 170 signups; 100× is about 7,000 shifts, 17,000 signups and 40,000 timeline rows. Postgres handles that easily with these indexes. The first problems come from query shapes, not table sizes:

1. **The dashboard**, the landing page that everyone hits first. Its per-program and per-state breakdown aggregates every live shift ever created, on every load. The fix is to window it (upcoming or recent only), or to keep a small summary table updated in the same transactions that change `signup_count`.
2. **The shift finder.** Each page runs `COUNT(*)` over the filtered set plus `OFFSET` paging, and the text search is `ILIKE '%term%'`, which can't use a B-tree index. Deep pages and broad searches turn into sequential scans. The fixes are `pg_trgm` GIN indexes on `programs.name` and `shifts.location`, keyset pagination (`WHERE (shift_date, start_time, id) > (...)`), and an estimated count past a threshold.
3. **The alert badge polling.** Every visible tab asks every 60 seconds (polling pauses while a tab is hidden). The query itself is a cheap date-range scan on `shifts_date_idx`, but at 100× the users it becomes steady load. The fix is a short server-side cache keyed by viewer scope, or pushing changes.
4. **Unbounded lists.** "My programs" returns every upcoming shift of every program a volunteer is in (past ones only on request), and the roster CSV is built in memory. Both would need paging or streaming.
5. **Housekeeping.** Expired sessions are deleted only when that user signs in again, so the table would grow; it needs a periodic cleanup.

Safe at 100×: anything keyed by shift (timeline, signups by shift_id), the overlap check (GiST index from the exclusion constraint), and the lifecycle transactions, which lock single rows.

## Limits worth knowing

- The append-only triggers protect history from the application and from mistakes. The database role that owns the tables could still disable them. In a real deployment the server would connect as a role with only `SELECT, INSERT` on `shift_events`, and migrations would run as the owner.
- Shift times are wall-clock. With the default zone (no daylight saving) that is exact; in a DST zone a shift spanning the change would be an hour off in duration.
- A shift belongs to the date it starts on: a 22:00–02:00 shift appears under its start date in filters, "this week" and alerts.
