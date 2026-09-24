import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

// The repository-root .env, found relative to this file (src/ in development,
// dist/ when built — both three levels below the root). `dotenv/config` looked
// in the working directory instead, and npm runs workspace scripts from
// apps/api, so `npm run dev`, `seed` and `migrate` never read the root .env and
// silently ran on defaults. Real environment variables still win: dotenv does
// not override them, which is how the containers are configured.
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

/**
 * An optional variable set to the empty string is unset. Compose passes
 * `${NAME:-}` through as "", which would otherwise fail its format check and
 * stop the process at boot over a value nobody meant to give.
 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  // Set to the number of trusted reverse-proxy hops in a real deployment. It
  // stays at zero locally: accepting X-Forwarded-For directly from a client
  // would let that client choose the address used by rate limits and auditing.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),

  DATABASE_URL: z
    .string()
    .default('postgresql://scholarshield:scholarshield@localhost:5432/scholarshield'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('scholarshield-documents'),
  S3_ACCESS_KEY: z.string().default('scholarshield'),
  S3_SECRET_KEY: z.string().default('scholarshield'),
  // Not z.coerce.boolean(): that is Boolean(value), and Boolean('false') is true.
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((value) => value === 'true' || value === '1'),
  // Where a BROWSER reaches object storage, for signed document URLs. Differs
  // from S3_ENDPOINT whenever the API reaches storage over a private network
  // name (http://minio:9000 in compose) that a reviewer's browser cannot resolve.
  S3_PUBLIC_ENDPOINT: optional(z.string().url()),

  OCR_SERVICE_URL: z.string().default('http://localhost:8000'),

  // Pre-filled manual verification link. No portal is ever scraped (PROJECT_REPORT.md
  // §5 Tier 3) — a reviewer opens this themselves and records what they saw.
  VERIFICATION_PORTAL_URL: z
    .string()
    .default('https://tnedistrict.tn.gov.in/tneda/verify.xhtml'),

  // Mail. Absent locally on purpose — see mail.ts. Required in production.
  SMTP_URL: optional(z.string()),
  MAIL_FROM: z.string().default('ScholarShield <no-reply@scholarshield.local>'),
  INVITE_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // Upload limits. Matched to the OCR service's own cap (OCR_MAX_UPLOAD_BYTES).
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(12 * 1024 * 1024),

  JWT_SECRET: z.string().min(32).default('dev-only-secret-do-not-use-in-production'),
  // Keys the anonymous-tip submitter hash. Separate from JWT_SECRET so rotating
  // session signing does not break abuse matching, and so one leaked secret
  // does not unlock both. Falls back to JWT_SECRET when unset.
  TIP_HASH_SECRET: optional(z.string().min(32)),
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().positive().default(20),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),

  DOCUMENT_RETENTION_DAYS: z.coerce.number().int().positive().default(180),

  SCHOLARSHIP_INCOME_CEILING: z.coerce.number().int().positive().default(250_000),
  CYCLE_DEADLINE: z.string().default('2026-07-31'),
  /** The cycle every public submission joins. Set by the server, never the form. */
  CURRENT_CYCLE: z.string().regex(/^\d{4}$/).default('2026'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

export const isProduction = config.NODE_ENV === 'production';

// A default secret is fine for local dev and tests; shipping one is not. Keep
// the compose demo value on this deny-list too: it is intentionally visible in
// the repository and must never become a deployment secret by accident.
const UNSAFE_PRODUCTION_JWT_SECRETS = new Set([
  'dev-only-secret-do-not-use-in-production',
  'compose-demo-secret-change-me-before-anything-real',
]);

if (isProduction && UNSAFE_PRODUCTION_JWT_SECRETS.has(config.JWT_SECRET)) {
  console.error('JWT_SECRET must be set to a unique secret in production.');
  process.exit(1);
}

// A deployment that cannot send a sign-in link cannot sign anyone in. Fail at
// boot rather than at someone's first login attempt.
if (isProduction && !config.SMTP_URL) {
  console.error('SMTP_URL must be set in production: sign-in links cannot be delivered.');
  process.exit(1);
}
