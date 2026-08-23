/**
 * Entity resolution — step 2 of the household reconciliation engine
 * (PROJECT_REPORT.md §5 Tier 1).
 *
 * Takes applications that have been through `normalize.ts` and decides which
 * pairs plausibly belong to the same household, emitting a weighted edge for
 * every field that matched.
 *
 * WHY TRIGRAMS ARE IMPLEMENTED HERE AND NOT ONLY IN POSTGRES
 * ----------------------------------------------------------
 * Production narrows candidates with a `pg_trgm` index — comparing every
 * application against every other is quadratic and pointless when an index can
 * discard almost all of them. But the *decision* has to be made somewhere
 * testable, and a scoring rule that lives in SQL can only be exercised with a
 * live database. So Postgres narrows, and this module scores. The trigram
 * function below mirrors `pg_trgm`'s (two leading pad characters, one trailing,
 * per word) so the two stages agree about what "similar" means.
 *
 * A NOTE ON CONSERVATISM
 * ----------------------
 * A false merge is worse than a missed one. Merging two unrelated families
 * invents a household, and every contradiction rule downstream then fires on it —
 * turning one resolution mistake into a high-severity flag against two innocent
 * applicants. So no single field links a household on its own: not a shared
 * surname, not a shared address, not a shared phone. Corroboration is required.
 */

import { nameCompatibility, normalizeIdentity, normalizeName } from './normalize.js';

export const MATCH_FIELDS = ['guardian_name', 'applicant_name', 'address', 'phone'] as const;
export type MatchField = (typeof MATCH_FIELDS)[number];

/**
 * Per-field contribution to a link decision.
 *
 * guardian_name is the strongest single signal — households share a guardian by
 * definition. address is close behind but weaker, because buildings hold many
 * families. applicant_name is weak: siblings share a surname, but so does half
 * the district. phone is weakest of all — a shared number can be a facilitator
 * filing on several families' behalf, a shared handset, or a transcription slip,
 * none of which make a household.
 */
export const FIELD_WEIGHTS: Record<MatchField, number> = {
  guardian_name: 0.5,
  address: 0.4,
  applicant_name: 0.2,
  phone: 0.15,
};

/** Below these, a field is not similar enough to be evidence of anything. */
export const FIELD_THRESHOLDS: Record<MatchField, number> = {
  guardian_name: 0.55,
  address: 0.6,
  applicant_name: 0.65,
  phone: 1, // exact or nothing — a partial phone match is meaningless
};

/**
 * Total weighted score at which two applications are considered one household.
 *
 * Set deliberately above the strongest single field (guardian_name at 0.5), so
 * that no lone field can link. Two `Ramesh Kumar`s in one district stay separate
 * households unless something corroborates.
 */
export const LINK_THRESHOLD = 0.55;

/** Mirrors `pg_trgm`'s tokenisation: two leading pads, one trailing, per word. */
export function trigrams(input: string): Set<string> {
  const out = new Set<string>();
  if (!input) return out;

  const words = input.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);

  for (const word of words) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) {
      out.add(padded.slice(i, i + 3));
    }
  }

  return out;
}

/** Jaccard similarity over trigram sets, as `pg_trgm.similarity()` computes it. */
export function trigramSimilarity(a: string, b: string): number {
  const setA = trigrams(a);
  const setB = trigrams(b);

  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const gram of setA) if (setB.has(gram)) intersection += 1;

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface ResolutionInput {
  id: string;
  applicantName: string;
  guardianName: string;
  addressLine: string;
  district?: string | null;
  guardianPhone?: string | null;
}

export interface ResolvedEdge {
  applicationAId: string;
  applicationBId: string;
  matchField: MatchField;
  similarity: number;
  weight: number;
}

export interface PairResolution {
  applicationAId: string;
  applicationBId: string;
  edges: ResolvedEdge[];
  /** Sum of weight × similarity across matched fields. */
  score: number;
  linked: boolean;
}

interface Prepared {
  id: string;
  applicantName: string;
  guardianName: string;
  address: string;
  phone: string | null;
  guardianParsed: ReturnType<typeof normalizeName>;
  applicantParsed: ReturnType<typeof normalizeName>;
}

function prepare(input: ResolutionInput): Prepared {
  const identity = normalizeIdentity(input);
  return {
    id: input.id,
    applicantName: identity.normalizedApplicantName,
    guardianName: identity.normalizedGuardianName,
    address: identity.normalizedAddress,
    phone: identity.normalizedPhone,
    guardianParsed: normalizeName(input.guardianName),
    applicantParsed: normalizeName(input.applicantName),
  };
}

function fieldSimilarity(field: MatchField, a: Prepared, b: Prepared): number {
  switch (field) {
    case 'guardian_name':
      // Trigrams cannot see that `M. Govindaraj` is `Muthusamy Govindaraj` — a
      // whole token is missing. nameCompatibility can. Take whichever is more
      // generous, since either being high is real evidence.
      return Math.max(
        trigramSimilarity(a.guardianName, b.guardianName),
        nameCompatibility(a.guardianParsed, b.guardianParsed),
      );
    case 'applicant_name':
      return Math.max(
        trigramSimilarity(a.applicantName, b.applicantName),
        nameCompatibility(a.applicantParsed, b.applicantParsed),
      );
    case 'address':
      return trigramSimilarity(a.address, b.address);
    case 'phone':
      if (!a.phone || !b.phone) return 0;
      return a.phone === b.phone ? 1 : 0;
  }
}

/** Score one pair, emitting an edge per field that cleared its threshold. */
export function resolvePair(a: ResolutionInput, b: ResolutionInput): PairResolution {
  return resolvePrepared(prepare(a), prepare(b));
}

function resolvePrepared(a: Prepared, b: Prepared): PairResolution {
  const edges: ResolvedEdge[] = [];
  let score = 0;

  for (const field of MATCH_FIELDS) {
    const similarity = fieldSimilarity(field, a, b);
    if (similarity < FIELD_THRESHOLDS[field]) continue;

    const weight = FIELD_WEIGHTS[field];
    edges.push({
      applicationAId: a.id,
      applicationBId: b.id,
      matchField: field,
      similarity: Number(similarity.toFixed(4)),
      weight,
    });
    score += weight * similarity;
  }

  return {
    applicationAId: a.id,
    applicationBId: b.id,
    edges,
    score: Number(score.toFixed(4)),
    linked: score >= LINK_THRESHOLD,
  };
}

/**
 * Resolve a whole set against itself.
 *
 * Quadratic, and knowingly so — this path exists for tests and for reconciling a
 * single household after Postgres has already narrowed the candidate set. Do not
 * point it at a full admission cycle; use the indexed candidate query for that
 * and feed the survivors through `resolvePair`.
 */
export function resolveAll(inputs: ResolutionInput[]): PairResolution[] {
  const prepared = inputs.map(prepare);
  const results: PairResolution[] = [];

  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const resolution = resolvePrepared(prepared[i]!, prepared[j]!);
      if (resolution.edges.length > 0) results.push(resolution);
    }
  }

  return results;
}

/** Just the linked pairs, which is what component detection consumes. */
export function linkedPairs(inputs: ResolutionInput[]): PairResolution[] {
  return resolveAll(inputs).filter((r) => r.linked);
}
