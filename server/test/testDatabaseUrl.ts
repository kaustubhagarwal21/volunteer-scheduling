export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://volunteer:volunteer@localhost:5433/volunteer_test';

// The global setup wipes this database. Refuse to run against anything not clearly a test database.
if (!new URL(TEST_DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error(`Refusing to run tests against ${TEST_DATABASE_URL}: database name must end in _test`);
}
