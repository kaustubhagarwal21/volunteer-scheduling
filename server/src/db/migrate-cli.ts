import { migrate } from './migrate';
import { pool } from './pool';

migrate(pool)
  .then((applied) => {
    console.log(applied.length ? `Done: ${applied.length} migration(s) applied.` : 'Database is up to date.');
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
