import pg from 'pg';
import { config } from '../config';

// DATE and TIMESTAMP (without time zone) hold wall-clock values. Turning them into JS Date objects
// would silently shift them by the Node process's UTC offset, so keep them as plain strings.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (value) => value);
// COUNT(*) and SUM(integer) return int8, which node-postgres gives back as a string by default.
// Every count in this app is far below 2^53, so a plain number is safe.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

// Note: queries never rely on the session time zone (CURRENT_DATE, LOCALTIMESTAMP...). The
// organisation's "today" and "now" are passed in explicitly; see time/orgClock.ts.
export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });

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
