import bcrypt from 'bcryptjs';

// bcrypt work factor: ~70ms per hash on a laptop, slow enough to make offline guessing expensive.
const COST = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// Compared against when the email is unknown, so a failed login takes the same time whether or
// not the account exists (otherwise response timing would reveal which emails are registered).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', COST);

export async function verifyPasswordOrDummy(plain: string, hash: string | undefined): Promise<boolean> {
  const ok = await bcrypt.compare(plain, hash ?? DUMMY_HASH);
  return ok && hash !== undefined;
}
