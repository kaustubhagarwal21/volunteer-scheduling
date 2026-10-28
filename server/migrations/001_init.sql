-- Initial schema for the volunteer scheduling system.
--
-- Times: a shift's date and start time are the organisation's local wall-clock time
-- (ORG_TIMEZONE). The application computes the organisation's "today" and "now" itself and passes
-- them into queries, so nothing here depends on the database session's time zone.
--
-- Rules the database enforces on its own (the application checks them first, for clear messages):
--   * a shift's fill state is a generated column: nobody can write it;
--   * signup_count must equal the number of active signups at commit, and never exceed the headcount;
--   * one volunteer can never hold two active signups whose time windows overlap;
--   * shift history (shift_events) is append-only.

CREATE EXTENSION IF NOT EXISTS btree_gist; -- lets the overlap constraint mix "=" on ids with "&&" on ranges

CREATE TYPE user_role AS ENUM ('coordinator', 'volunteer');

-- Declaration order is the lifecycle order, so ORDER BY state sorts Open -> Closed.
CREATE TYPE shift_state AS ENUM ('open', 'partially_filled', 'filled', 'closed');

CREATE TYPE shift_event_type AS ENUM (
  'created',
  'updated',
  'state_changed',
  'signup_created',
  'signup_cancelled',
  'note',
  'alert_dismissed',
  'deleted'
);

CREATE TABLE users (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  name          TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  password_hash TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'volunteer',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Server-side sessions. The cookie holds a random token; only its SHA-256 hash is stored,
-- so a leaked sessions table cannot be replayed as cookies.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE programs (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  description TEXT NOT NULL DEFAULT '',
  archived_at TIMESTAMPTZ,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Many-to-many: a volunteer belongs to any number of programs and vice versa.
CREATE TABLE program_members (
  program_id INTEGER NOT NULL REFERENCES programs(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  added_by   INTEGER NOT NULL REFERENCES users(id),
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (program_id, user_id)
);
CREATE INDEX program_members_user_id_idx ON program_members (user_id);

CREATE TABLE shifts (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  program_id         INTEGER NOT NULL REFERENCES programs(id),
  shift_date         DATE NOT NULL CHECK (shift_date BETWEEN '2000-01-01' AND '2999-12-31'),
  -- Whole minutes only, and never '24:00' (which would be the next day's 00:00 in disguise).
  start_time         TIME(0) NOT NULL CHECK (start_time < '24:00' AND date_part('second', start_time) = 0),
  duration_minutes   INTEGER NOT NULL CHECK (duration_minutes BETWEEN 15 AND 1440),
  location           TEXT NOT NULL CHECK (length(btrim(location)) > 0),
  required_headcount INTEGER NOT NULL CHECK (required_headcount BETWEEN 1 AND 500),

  -- Denormalised count of active signups. Maintained by the application in the same transaction
  -- as each signup/cancellation (under a row lock); verified at commit by a trigger below.
  signup_count       INTEGER NOT NULL DEFAULT 0,

  closed_at          TIMESTAMPTZ,
  closed_by          INTEGER REFERENCES users(id),
  deleted_at         TIMESTAMPTZ,
  deleted_by         INTEGER REFERENCES users(id),
  alert_dismissed_at TIMESTAMPTZ,
  alert_dismissed_by INTEGER REFERENCES users(id),
  created_by         INTEGER NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Local wall-clock window [start, end), used for overlap checks and "has it started / ended".
  time_range TSRANGE GENERATED ALWAYS AS (
    tsrange(
      shift_date + start_time,
      shift_date + start_time + make_interval(mins => duration_minutes),
      '[)'
    )
  ) STORED,

  -- The fill state is derived, never written: Postgres rejects any attempt to set it.
  state shift_state GENERATED ALWAYS AS (
    CASE
      WHEN closed_at IS NOT NULL THEN 'closed'::shift_state
      WHEN signup_count = 0 THEN 'open'::shift_state
      WHEN signup_count < required_headcount THEN 'partially_filled'::shift_state
      ELSE 'filled'::shift_state
    END
  ) STORED,

  CONSTRAINT shifts_signup_count_within_headcount
    CHECK (signup_count >= 0 AND signup_count <= required_headcount),
  CONSTRAINT shifts_closed_fields_together CHECK ((closed_at IS NULL) = (closed_by IS NULL)),
  CONSTRAINT shifts_deleted_fields_together CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  -- Target for the signups foreign key below (id alone is already unique).
  CONSTRAINT shifts_id_time_range_key UNIQUE (id, time_range)
);

-- One live shift per program per date+start time. This is also how recurring generation
-- detects "a shift already existed for that program at that date and time".
CREATE UNIQUE INDEX shifts_program_slot_uidx
  ON shifts (program_id, shift_date, start_time) WHERE deleted_at IS NULL;
CREATE INDEX shifts_date_idx ON shifts (shift_date, start_time) WHERE deleted_at IS NULL;

CREATE TABLE signups (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id     INTEGER NOT NULL,
  volunteer_id INTEGER NOT NULL REFERENCES users(id),
  -- Copy of the shift's time window so the overlap constraint below can see it. The composite
  -- foreign key guarantees it always equals the shift's window: rescheduling a shift cascades
  -- here, and the overlap constraint re-checks the volunteers on the way.
  time_range   TSRANGE NOT NULL,
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  cancelled_by INTEGER REFERENCES users(id),

  CONSTRAINT signups_shift_window_fkey
    FOREIGN KEY (shift_id, time_range) REFERENCES shifts (id, time_range) ON UPDATE CASCADE,
  CONSTRAINT signups_cancel_fields_together CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL)),
  -- No volunteer can hold two active signups whose time windows overlap, even under
  -- concurrent requests.
  CONSTRAINT signups_no_overlap
    EXCLUDE USING gist (volunteer_id WITH =, time_range WITH &&) WHERE (cancelled_at IS NULL)
);
CREATE UNIQUE INDEX signups_one_active_per_shift_uidx
  ON signups (shift_id, volunteer_id) WHERE cancelled_at IS NULL;
CREATE INDEX signups_shift_id_idx ON signups (shift_id);
CREATE INDEX signups_volunteer_id_idx ON signups (volunteer_id);
CREATE INDEX signups_created_at_idx ON signups (created_at);

-- At COMMIT, every shift whose count or signups changed must have signup_count equal to its
-- number of active signups. A code path that forgets to adjust the count, or anyone setting it by
-- hand, fails here instead of silently corrupting the fill state.
CREATE FUNCTION shifts_check_signup_count() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target integer;
  stored integer;
  actual integer;
BEGIN
  IF TG_TABLE_NAME = 'shifts' THEN target := NEW.id; ELSE target := NEW.shift_id; END IF;
  SELECT signup_count INTO stored FROM shifts WHERE id = target;
  SELECT count(*) INTO actual FROM signups WHERE shift_id = target AND cancelled_at IS NULL;
  IF stored <> actual THEN
    RAISE EXCEPTION 'shift %: signup_count is % but it has % active signups', target, stored, actual
      USING ERRCODE = 'check_violation', CONSTRAINT = 'shifts_signup_count_matches';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER shifts_signup_count_matches
  AFTER INSERT OR UPDATE OF signup_count ON shifts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION shifts_check_signup_count();

CREATE CONSTRAINT TRIGGER signups_signup_count_matches
  AFTER INSERT OR UPDATE OF cancelled_at ON signups
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION shifts_check_signup_count();

-- Append-only history for every shift.
CREATE TABLE shift_events (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id     INTEGER NOT NULL REFERENCES shifts(id),
  event_type   shift_event_type NOT NULL,
  actor_id     INTEGER NOT NULL REFERENCES users(id),
  volunteer_id INTEGER REFERENCES users(id),
  from_state   shift_state,
  to_state     shift_state,
  note         TEXT,
  details      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT shift_events_state_change_shape CHECK (
    event_type <> 'state_changed'
    OR (from_state IS NOT NULL AND to_state IS NOT NULL AND from_state <> to_state)
  ),
  CONSTRAINT shift_events_note_shape CHECK (
    event_type <> 'note' OR (note IS NOT NULL AND length(btrim(note)) > 0)
  ),
  CONSTRAINT shift_events_signup_shape CHECK (
    event_type NOT IN ('signup_created', 'signup_cancelled') OR volunteer_id IS NOT NULL
  )
);
CREATE INDEX shift_events_shift_id_idx ON shift_events (shift_id, id);

CREATE FUNCTION shift_events_forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'shift history is append-only: % on shift_events is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER shift_events_no_update_or_delete
  BEFORE UPDATE OR DELETE ON shift_events
  FOR EACH ROW EXECUTE FUNCTION shift_events_forbid_change();

CREATE TRIGGER shift_events_no_truncate
  BEFORE TRUNCATE ON shift_events
  FOR EACH STATEMENT EXECUTE FUNCTION shift_events_forbid_change();
