import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

// Same relative location from src/db (tsx) and dist/db (compiled): server/migrations.
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

// Arbitrary constant. Holding this advisory lock serialises concurrent migration runs,
// e.g. two server instances booting at the same time.
const MIGRATION_LOCK_ID = 727_001;

/**
 * Applies every migrations/*.sql file that has not been applied yet, in filename order.
 * Each file runs in its own transaction and is recorded in schema_migrations.
 */
export async function migrate(pool: pg.Pool, log: (msg: string) => void = console.log): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const alreadyApplied = new Set(rows.map((row) => row.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();

    const applied: string[] = [];
    for (const file of files) {
      if (alreadyApplied.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`Applied migration ${file}`);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}
