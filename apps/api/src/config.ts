import 'dotenv/config';
import { z } from 'zod';

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
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),

  OCR_SERVICE_URL: z.string().default('http://localhost:8000'),

  // Pre-filled manual verification link. No portal is ever scraped (PROJECT_REPORT.md
  // §5 Tier 3) — a reviewer opens this themselves and records what they saw.
  VERIFICATION_PORTAL_URL: z
    .string()
    .default('https://tnedistrict.tn.gov.in/tneda/verify.xhtml'),

  // Mail. Absent locally on purpose — see mail.ts. Required in production.
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('ScholarShield <no-reply@scholarshield.local>'),
  INVITE_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // Upload limits. Matched to the OCR service's own cap (OCR_MAX_UPLOAD_BYTES).
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(12 * 1024 * 1024),

  JWT_SECRET: z.string().min(32).default('dev-only-secret-do-not-use-in-production'),
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().positive().default(20),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),

  DOCUMENT_RETENTION_DAYS: z.coerce.number().int().positive().default(180),

  SCHOLARSHIP_INCOME_CEILING: z.coerce.number().int().positive().default(250_000),
  CYCLE_DEADLINE: z.string().default('2026-07-31'),
  /** The cycle a new submission joins when the form does not name one. */
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
