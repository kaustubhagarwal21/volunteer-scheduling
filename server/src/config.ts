import { z } from 'zod';

// Local development reads server/.env. Tests set their own environment (see vitest.config.mts),
// and the production host injects real environment variables, so neither loads the file.
if (process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'production') {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: rely on the environment as-is.
  }
}

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Shift dates and times are wall-clock times in this zone; "today" and "this week" use it too.
  ORG_TIMEZONE: z
    .string()
    .default('Asia/Kolkata')
    .refine(isValidTimeZone, 'ORG_TIMEZONE must be an IANA time zone such as Asia/Kolkata'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = parsed.data;
export const isProduction = config.NODE_ENV === 'production';
