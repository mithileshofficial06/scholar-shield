/**
 * Rule-config loading.
 *
 * The config version is stamped onto every `risk_flags` row, so a score computed
 * six months ago stays reproducible against the weights that produced it. That
 * only holds if a published version is never edited in place — change weights by
 * adding `rules.v2.json`, never by editing v1.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import type { RulesConfig } from './rules.js';

const ruleSchema = z.object({
  enabled: z.boolean(),
  severity: z.enum(['low', 'medium', 'high']),
  weight: z.number().nonnegative(),
  incomeTolerancePercent: z.number().positive().optional(),
  incomeToleranceAbsolute: z.number().nonnegative().optional(),
  minDistinctHouseholds: z.number().int().min(2).optional(),
  windowDays: z.number().int().positive().optional(),
  requiresCorroboration: z.boolean().optional(),
  minOcrConfidence: z.number().min(0).max(1).optional(),
  minNameSimilarity: z.number().min(0).max(1).optional(),
  minWordCount: z.number().int().nonnegative().optional(),
  minIdentifyingFields: z.number().int().min(1).optional(),
  minTamperScore: z.number().min(0).max(1).optional(),
  bunchingBandPercent: z.number().positive().max(100).optional(),
  minBandCount: z.number().int().min(2).optional(),
  bunchingRatio: z.number().positive().optional(),
  maxSerialSpan: z.number().int().nonnegative().optional(),
  roundIncomeStep: z.number().int().positive().optional(),
  nearMissFloor: z.number().min(0).max(1).optional(),
  minNearMissFields: z.number().int().min(1).optional(),
  // Prose kept alongside each rule explaining why it is weighted as it is.
  note: z.string().optional(),
});

const configSchema = z.object({
  version: z.string().min(1),
  description: z.string().optional(),
  scholarshipIncomeCeiling: z.number().positive(),
  highSeverityScoreThreshold: z.number().positive(),
  rules: z.record(ruleSchema),
});

const here = path.dirname(fileURLToPath(import.meta.url));
const configDir = path.resolve(here, '../../../../config');

/** The version new flags are scored under. Older files stay loadable for reproduction. */
export const ACTIVE_RULES_VERSION = 'v5';

export function loadRulesConfig(version = ACTIVE_RULES_VERSION): RulesConfig {
  const file = path.join(configDir, `rules.${version}.json`);
  const parsed = configSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));

  if (!parsed.success) {
    throw new Error(
      `Invalid rule config at ${file}: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`,
    );
  }

  if (parsed.data.version !== version) {
    // A file whose declared version disagrees with its filename would stamp the
    // wrong version onto flags, quietly breaking reproducibility.
    throw new Error(
      `Rule config ${file} declares version "${parsed.data.version}" but is named "${version}".`,
    );
  }

  return parsed.data;
}
