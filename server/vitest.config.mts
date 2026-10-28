import { defineConfig } from 'vitest/config';
import { TEST_DATABASE_URL } from './test/testDatabaseUrl';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      ORG_TIMEZONE: 'Asia/Kolkata',
    },
    // All test files share one database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
