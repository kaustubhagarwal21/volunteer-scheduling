import pg from 'pg';
import { config } from '../config';

// DATE and TIMESTAMP (without time zone) hold wall-clock values. Turning them into JS Date objects
// would silently shift them by the Node process's UTC offset, so keep them as plain strings.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (value) => value);
// COUNT(*) and SUM(integer) return int8, which node-postgres gives back as a string by default.
// Every count in this app is far below 2^53, so a plain number is safe.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });

// Run every session in the organisation's time zone, so CURRENT_DATE, LOCALTIMESTAMP and
// date_trunc('week', now()) mean "today", "now" and "this week" for the organisation.
// set_config takes the zone as a bind parameter, so the value is never spliced into SQL.
pool.on('connect', (client) => {
  client
    .query("SELECT set_config('TimeZone', $1, false)", [config.ORG_TIMEZONE])
    .catch((err: unknown) => console.error('Failed to set session time zone', err));
});

pool.on('error', (err) => {
  // An idle client lost its connection (e.g. the database restarted). The pool discards it;
  // log instead of crashing the process.
  console.error('Idle database client error', err);
});

/** Anything that can run a query: the pool itself or a client inside a transaction. */
export type Queryable = pg.Pool | pg.PoolClient;

/**
 * Runs `work` inside BEGIN/COMMIT on a dedicated client, rolling back on any error.
 * Every multi-step business operation goes through here so it is all-or-nothing.
 */
export async function withTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let connectionBroken = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      connectionBroken = true;
    });
    throw err;
  } finally {
    // Passing true destroys a client whose connection is unusable instead of returning it to the pool.
    client.release(connectionBroken || undefined);
  }
}
