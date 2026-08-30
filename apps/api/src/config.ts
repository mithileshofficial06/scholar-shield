import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),

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

  JWT_SECRET: z.string().min(16).default('dev-only-secret-do-not-use-in-production'),
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().positive().default(20),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),

  DOCUMENT_RETENTION_DAYS: z.coerce.number().int().positive().default(180),

  SCHOLARSHIP_INCOME_CEILING: z.coerce.number().int().positive().default(250_000),
  CYCLE_DEADLINE: z.string().default('2026-07-31'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

export const isProduction = config.NODE_ENV === 'production';

// A default secret is fine for local dev and tests; shipping one is not.
if (isProduction && config.JWT_SECRET.startsWith('dev-only')) {
  console.error('JWT_SECRET must be set to a real value in production.');
  process.exit(1);
}
