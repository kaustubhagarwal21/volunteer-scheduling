import { createApp } from './app';
import { config } from './config';
import { migrate } from './db/migrate';
import { pool } from './db/pool';

async function main() {
  // Migrations run on every boot; already-applied files are skipped, so this is a no-op normally.
  await migrate(pool);

  const server = createApp().listen(config.PORT, () => {
    console.log(`Server listening on port ${config.PORT} (org time zone ${config.ORG_TIMEZONE})`);
  });

  // The host sends SIGTERM before replacing the instance on a deploy: finish in-flight requests first.
  process.on('SIGTERM', () => {
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  });
}

main().catch((err: unknown) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
