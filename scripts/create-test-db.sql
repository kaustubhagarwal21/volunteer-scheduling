-- Runs once when the local Postgres container is first created.
-- The integration tests use their own database so they never touch dev data.
CREATE DATABASE volunteer_test OWNER volunteer;
