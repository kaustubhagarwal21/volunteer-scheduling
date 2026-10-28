import { afterAll } from 'vitest';
import { pool } from '../src/db/pool';

// Each test file gets its own module instances, so close that file's pool when it finishes.
afterAll(async () => {
  await pool.end();
});
