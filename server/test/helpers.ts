import request from 'supertest';
import { createApp } from '../src/app';
import { hashPassword } from '../src/auth/passwords';
import type { AuthUser, Role } from '../src/auth/types';
import { pool } from '../src/db/pool';

export const app = createApp();
export const PASSWORD = 'password123';

let counter = 0;
/** Unique suffix so every test builds its own users/programs and never collides with another test. */
export function unique(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}`;
}

let passwordHash: Promise<string> | undefined;

export async function createUser(role: Role, name?: string): Promise<AuthUser> {
  passwordHash ??= hashPassword(PASSWORD);
  const tag = unique();
  const { rows } = await pool.query<AuthUser>(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4)
     RETURNING id, email, name, role`,
    [`${role}-${tag}@test.local`, name ?? `${role} ${tag}`, await passwordHash, role],
  );
  return rows[0];
}

/** A supertest agent that keeps cookies between requests, signed in as `user`. */
export async function signIn(user: AuthUser) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email: user.email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`Sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}
