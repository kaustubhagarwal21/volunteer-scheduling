import pg from 'pg';
import { migrate } from '../src/db/migrate';
import { TEST_DATABASE_URL } from './testDatabaseUrl';

/** Runs once before the whole suite: rebuild the test database schema from the migrations. */
export default async function setup() {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool, () => {});
  } finally {
    await pool.end();
  }
}
