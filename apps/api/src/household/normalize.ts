/**
 * Identity normalization — the input layer of the household reconciliation engine
 * (PROJECT_REPORT.md §5 Tier 1, step 1).
 *
 * DIVISION OF LABOUR
 * ------------------
 * Normalization is deterministic and deliberately conservative. It collapses the
 * variance that is purely orthographic — casing, punctuation, honorifics, common
 * Indian transliteration alternates — and stops there. Residual variance is left
 * to trigram similarity at the resolution step, because a normalizer aggressive
 * enough to force every variant of a name into one string also forces genuinely
 * different names together, and a false merge is worse than a missed one here:
 * it invents a household that does not exist and flags two unrelated families.
 *
 * So: `Muthuswami` and `Muthusamy` canonicalise to `mutusvami` and `mutusami` —
 * close, not identical. Getting them from "close" to "same household" is the
 * resolver's job, where the decision is weighted, recorded as an edge, and can be
 * rejected by a reviewer.
 */

/** Honorifics and titles common on Indian civic documents. */
const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'shri', 'sri', 'smt', 'kum',
  'thiru', 'thirumathi', 'tmt', 'selvi', 'selvan', 'master', 'md',
  's/o', 'd/o', 'w/o', 'c/o', 'so', 'do', 'wo', 'co',
]);

/**
 * Transliteration alternates. Applied in order — longer digraphs first, so `th`
 * is consumed before a later rule could touch the `h`.
 */
const TRANSLITERATION_RULES: Array<[RegExp, string]> = [
  [/tch/g, 'c'],
  [/th/g, 't'],
  [/dh/g, 'd'],
  [/bh/g, 'b'],
  [/gh/g, 'g'],
  [/kh/g, 'k'],
  [/ph/g, 'f'],
  [/sh/g, 's'],
  [/ch/g, 'c'],
  [/ck/g, 'k'],
  [/ee/g, 'i'],
  [/ea/g, 'i'],
  [/oo/g, 'u'],
  [/ou/g, 'u'],
  [/aa/g, 'a'],
  [/ii/g, 'i'],
  [/uu/g, 'u'],
  [/w/g, 'v'],
  [/z/g, 'j'],
  [/x/g, 'ks'],
  [/q/g, 'k'],
  // Terminal -y and -i are the same sound and vary by transcriber, not by name:
  // Samy/Sami, Swamy/Swami, Reddy/Reddi, Murthy/Murthi. Only terminal — a medial
  // y (Ayanavaram) is load-bearing.
  [/y$/g, 'i'],
];

/** Address abbreviations, expanded so `14 Bharathi St` and `14 Bharathi Street` agree. */
const ADDRESS_EXPANSIONS: Record<string, string> = {
  st: 'street',
  str: 'street',
  rd: 'road',
  ro: 'road',
  ave: 'avenue',
  av: 'avenue',
  ln: 'lane',
  blk: 'block',
  bldg: 'building',
  apt: 'apartment',
  apts: 'apartment',
  flr: 'floor',
  fl: 'floor',
  ngr: 'nagar',
  ngar: 'nagar',
  clny: 'colony',
  col: 'colony',
  crs: 'cross',
  mn: 'main',
  ext: 'extension',
  extn: 'extension',
  opp: 'opposite',
  nr: 'near',
  behind: 'behind',
  no: '',
  num: '',
  door: '',
  dno: '',
  'd.no': '',
};

/** Ordinal suffixes: `2nd Cross` and `2 Cross` are the same place. */
const ORDINAL = /\b(\d+)(st|nd|rd|th)\b/g;

function stripDiacritics(input: string): string {
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function applyTransliteration(input: string): string {
  let out = input;
  for (const [pattern, replacement] of TRANSLITERATION_RULES) {
    out = out.replace(pattern, replacement);
  }
  // Collapse doubled letters last — `mm`, `nn`, `ll` carry no distinguishing
  // information once the digraph rules above have run.
  return out.replace(/(.)\1+/g, '$1');
}

export interface NormalizedName {
  /** Space-joined canonical tokens, in the order given. */
  canonical: string;
  /** Canonical tokens, longest-first order preserved from input. */
  tokens: string[];
  /** Single-letter tokens, which are initials rather than names. */
  initials: string[];
}

export function normalizeName(raw: string | null | undefined): NormalizedName {
  if (!raw) return { canonical: '', tokens: [], initials: [] };

  const cleaned = stripDiacritics(raw)
    .toLowerCase()
    // Keep letters and the separators that carry meaning; drop everything else.
    .replace(/[^a-z\s./]/g, ' ')
    // `M.Govindaraj` and `M. Govindaraj` and `M/Govindaraj` all split the same way.
    .replace(/[./]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const rawTokens = cleaned.split(' ').filter((t) => t.length > 0 && !HONORIFICS.has(t));

  const tokens: string[] = [];
  const initials: string[] = [];

  for (const token of rawTokens) {
    if (token.length === 1) {
      initials.push(token);
      continue;
    }
    const canonicalToken = applyTransliteration(token);
    if (canonicalToken.length > 0) tokens.push(canonicalToken);
  }

  return { canonical: tokens.join(' '), tokens, initials };
}

export function normalizeAddress(raw: string | null | undefined): string {
  if (!raw) return '';

  const cleaned = stripDiacritics(raw)
    .toLowerCase()
    .replace(ORDINAL, '$1')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const expanded = cleaned
    .split(' ')
    .map((token) => {
      if (Object.prototype.hasOwnProperty.call(ADDRESS_EXPANSIONS, token)) {
        return ADDRESS_EXPANSIONS[token];
      }
      return token;
    })
    .filter((token): token is string => Boolean(token && token.length > 0));

  // Transliterate the non-numeric parts so `Bharathi` and `Barati` agree.
  const canonical = expanded.map((token) =>
    /^\d+$/.test(token) ? token : applyTransliteration(token),
  );

  return canonical.join(' ');
}

/**
 * Indian mobile numbers, reduced to the significant ten digits. `+91 98401 12233`,
 * `098401-12233`, and `9840112233` are one number.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10) return null;

  const last10 = digits.slice(-10);
  // A valid Indian mobile starts 6–9; anything else is a landline or a typo, and
  // treating it as an identity key would create edges on junk.
  if (!/^[6-9]/.test(last10)) return null;

  return last10;
}

/**
 * A rupee figure as printed on a certificate, reduced to whole rupees.
 * `Rs. 4,80,000/-`, `₹4,80,000.00` and `480000` are one amount. Paise are
 * dropped rather than read as more digits, which would multiply the figure by a
 * hundred. Anything without a number in it is null, not zero: an unread figure
 * must not look like a declared income of nothing.
 */
export function normalizeRupees(raw: string | null | undefined): number | null {
  if (!raw) return null;

  const match = /\d[\d,]*(?:\.\d+)?/.exec(raw);
  if (!match) return null;

  const rupees = Number(match[0].split('.')[0]!.replace(/,/g, ''));
  return Number.isSafeInteger(rupees) ? rupees : null;
}

/** Everything the resolver reads, derived from what the applicant declared. */
export interface NormalizedIdentityFields {
  normalizedApplicantName: string;
  normalizedGuardianName: string;
  normalizedAddress: string;
  normalizedPhone: string | null;
}

export function normalizeIdentity(input: {
  applicantName: string;
  guardianName: string;
  addressLine: string;
  district?: string | null;
  guardianPhone?: string | null;
}): NormalizedIdentityFields {
  // District is folded into the address so two identical street addresses in
  // different districts do not collide.
  const addressBasis = input.district
    ? `${input.addressLine} ${input.district}`
    : input.addressLine;

  return {
    normalizedApplicantName: normalizeName(input.applicantName).canonical,
    normalizedGuardianName: normalizeName(input.guardianName).canonical,
    normalizedAddress: normalizeAddress(addressBasis),
    normalizedPhone: normalizePhone(input.guardianPhone),
  };
}
