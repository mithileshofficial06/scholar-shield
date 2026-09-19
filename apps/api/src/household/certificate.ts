/**
 * The certificate against the form it came with.
 *
 * Every other check in the engine compares applications with each other, using
 * what applicants typed. These compare one application with its own uploaded
 * certificate, as OCR read it: is it this applicant's certificate, is it the
 * certificate they named, does it describe the family they described?
 *
 * One function per question, used twice — by the rules, which flag a failure,
 * and by the reviewer's checklist, which shows every comparison including the
 * ones that passed. Sharing it is what keeps the checklist and the flags from
 * ever disagreeing about the same document.
 *
 * A comparison is only as good as the read behind it. A field OCR could not
 * read, or read below the confidence floor, is SKIPPED, never failed: an
 * unreadable word on an honest certificate must not look like a lie.
 */

import { normalizeName, normalizeRupees, type NormalizedName } from './normalize.js';
import { nameSimilarity, trigramSimilarity } from './resolve.js';

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface OcrField {
  value: string | null;
  confidence: number;
}

/** What the pipeline learned from the uploaded certificate. */
export interface CertificateEvidence {
  fields: Record<string, OcrField | undefined>;
  /** Figures and words disagree; null when either could not be parsed or was never recorded. */
  incomeWordsMismatch: boolean | null;
  /** 0–1, or null when forensics has not run. */
  tamperScore: number | null;
  /** False when ELA could not run on this file; null when forensics has not run. */
  elaApplied: boolean | null;
  /** Software named in the file's metadata (EXIF, or a PDF's Producer/Creator). */
  softwareTags: string[];
}

/** The declared side of each comparison. */
export interface DeclaredDetails {
  applicantName: string;
  guardianName?: string | null;
  district?: string | null;
  pincode?: string | null;
  declaredFamilySize: number;
  certificateId: string | null;
}

export type ComparedField =
  | 'applicant_name'
  | 'guardian_name'
  | 'certificate_id'
  | 'district'
  | 'pincode'
  | 'family_size';

export interface FieldComparison {
  field: ComparedField;
  label: string;
  status: CheckStatus;
  declared: string | null;
  certificate: string | null;
  confidence: number | null;
  reason: string;
}

export interface ComparisonOptions {
  /** Below this OCR confidence a field is not relied on. */
  minOcrConfidence: number;
  /** Name parts must agree at least this well (see nameSimilarity). */
  minNameSimilarity: number;
}

export const DEFAULT_COMPARISON: ComparisonOptions = { minOcrConfidence: 0.8, minNameSimilarity: 0.25 };

/** Holder: whose certificate is this? */
export const HOLDER_FIELDS: readonly ComparedField[] = ['applicant_name', 'guardian_name'];
/** Identity: is it the certificate they named? */
export const NUMBER_FIELDS: readonly ComparedField[] = ['certificate_id'];
/** Particulars: does it describe the family they described? */
export const DETAIL_FIELDS: readonly ComparedField[] = ['district', 'pincode', 'family_size'];

const LABELS: Record<ComparedField, string> = {
  applicant_name: 'Applicant name',
  guardian_name: 'Guardian name',
  certificate_id: 'Certificate number',
  district: 'District',
  pincode: 'PIN code',
  family_size: 'Family size',
};

const alnum = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
const digits = (value: string) => value.replace(/\D/g, '');

/**
 * How each field is judged equal. Names tolerate transliteration and OCR noise
 * within a part; identifiers and numbers must match exactly once formatting is
 * stripped, because "close" is not a property a certificate number can have.
 */
function agrees(field: ComparedField, declared: string, read: string, options: ComparisonOptions): boolean {
  switch (field) {
    case 'applicant_name':
    case 'guardian_name':
      return namesAgree(declared, read, options.minNameSimilarity);
    case 'certificate_id':
      return alnum(declared) === alnum(read);
    case 'district':
      // Tolerant like a name: OCR reads "Madurai" as "Maduraj" at high
      // confidence, and a different district shares almost no trigrams.
      return alnum(declared) === alnum(read) || trigramSimilarity(alnum(declared).toLowerCase(), alnum(read).toLowerCase()) >= 0.5;
    case 'pincode':
      // The first three digits are the postal sorting district; the last three
      // a post office within it. Comparing the district only catches a
      // certificate from elsewhere without failing a move across town — or a
      // single misread digit, which OCR produced here at 91% confidence.
      return digits(declared).slice(0, 3) === digits(read).slice(0, 3);
    case 'family_size':
      return digits(declared) !== '' && Number(digits(declared)) === Number(digits(read));
  }
}

/**
 * A name's consonant skeleton: first letter kept, later vowels dropped.
 * Vowels are where romanised Indian names vary most (Mohammed / Muhammad,
 * Kavya / Kaviya) and what the shared normalizer does not fold.
 */
function skeleton(name: NormalizedName): NormalizedName {
  return { ...name, tokens: name.tokens.map((t) => t[0] + t.slice(1).replace(/[aeiouy]/g, '')) };
}

/**
 * Is the certificate's name the form's name? The better of the plain and the
 * skeleton similarity, against a threshold chosen from measured pairs: the same
 * person spelled or read differently scored 0.30 and up (Ramaswamy/Ramasamy,
 * Senthil/Sendil, an OCR "rn" for "m"), different people 0.20 and below
 * (Divya/Kavya, Karthik/Kavya). Near-identical different names — Arun and Aruna —
 * are beyond any spelling test; the reviewer sees both names on the checklist.
 */
function namesAgree(declared: string, read: string, threshold: number): boolean {
  const [a, b] = withoutSharedInitials(normalizeName(declared), normalizeName(read));
  return Math.max(nameSimilarity(a, b), nameSimilarity(skeleton(a), skeleton(b))) >= threshold;
}

/**
 * Drop initials both names carry. nameSimilarity pairs an initial only with a
 * full name part on the other side, so "V. Ramachandran" against itself scored
 * 0 — the V found no part to stand in for. An initial on both sides is simply
 * agreement.
 */
function withoutSharedInitials(a: NormalizedName, b: NormalizedName): [NormalizedName, NormalizedName] {
  const shared = a.initials.filter((initial) => b.initials.includes(initial));
  const drop = (name: NormalizedName) => {
    const remaining = [...name.initials];
    for (const initial of shared) remaining.splice(remaining.indexOf(initial), 1);
    return { ...name, initials: remaining };
  };
  return [drop(a), drop(b)];
}

function declaredValue(field: ComparedField, declared: DeclaredDetails): string | null {
  const value = {
    applicant_name: declared.applicantName,
    guardian_name: declared.guardianName,
    certificate_id: declared.certificateId,
    district: declared.district,
    pincode: declared.pincode,
    family_size: String(declared.declaredFamilySize),
  }[field];
  return value && value.trim() !== '' ? value.trim() : null;
}

export function compareField(
  field: ComparedField,
  declared: DeclaredDetails,
  evidence: CertificateEvidence | null | undefined,
  options: ComparisonOptions = DEFAULT_COMPARISON,
): FieldComparison {
  const label = LABELS[field];
  const declaredText = declaredValue(field, declared);
  const read = evidence?.fields[field];
  const readText = read?.value?.trim() || null;
  const base = { field, label, declared: declaredText, certificate: readText, confidence: read?.confidence ?? null };

  if (!evidence) return { ...base, status: 'skipped', reason: 'No certificate has been read for this application.' };
  if (!declaredText) return { ...base, status: 'skipped', reason: 'The applicant did not declare this field.' };
  if (!readText) return { ...base, status: 'skipped', reason: 'OCR could not find this field on the certificate.' };
  if ((read?.confidence ?? 0) < options.minOcrConfidence) {
    return {
      ...base,
      status: 'skipped',
      reason: `OCR read this field at ${Math.round((read?.confidence ?? 0) * 100)}% confidence, below the ${Math.round(options.minOcrConfidence * 100)}% needed to rely on it.`,
    };
  }

  return agrees(field, declaredText, readText, options)
    ? { ...base, status: 'pass', reason: 'The certificate agrees with the form.' }
    : { ...base, status: 'fail', reason: `The form says "${declaredText}"; the certificate reads "${readText}".` };
}

export function compareFields(
  fields: readonly ComparedField[],
  declared: DeclaredDetails,
  evidence: CertificateEvidence | null | undefined,
  options: ComparisonOptions = DEFAULT_COMPARISON,
): FieldComparison[] {
  return fields.map((field) => compareField(field, declared, evidence, options));
}

/** Figures and words on the certificate itself. Needs no declaration at all. */
export function incomeWordsCheck(
  evidence: CertificateEvidence | null | undefined,
  options: ComparisonOptions = DEFAULT_COMPARISON,
): { status: CheckStatus; reason: string; figure: string | null; words: string | null } {
  const figure = evidence?.fields.annual_income;
  const words = evidence?.fields.annual_income_words;
  const shown = { figure: figure?.value ?? null, words: words?.value ?? null };

  if (!evidence) return { ...shown, status: 'skipped', reason: 'No certificate has been read for this application.' };
  if (evidence.incomeWordsMismatch === null) {
    return { ...shown, status: 'skipped', reason: 'The income in figures or in words could not be read, so they could not be compared.' };
  }
  const weakest = Math.min(figure?.confidence ?? 0, words?.confidence ?? 0);
  if (weakest < options.minOcrConfidence) {
    return { ...shown, status: 'skipped', reason: `One of the two income lines was read below ${Math.round(options.minOcrConfidence * 100)}% confidence.` };
  }
  return evidence.incomeWordsMismatch
    ? { ...shown, status: 'fail', reason: `The income in figures (${shown.figure}) and in words (${shown.words}) disagree. Someone editing one line often misses the other.` }
    : { ...shown, status: 'pass', reason: 'The income in figures and in words agree.' };
}

/**
 * Tools whose name in a certificate's metadata means an image editor touched
 * it. A government portal's export or a scanner app is not on the list: being
 * scanned or exported is how every certificate arrives. Nor are Acrobat, Foxit
 * or the online compressors — applicants use them to make a PDF or shrink it
 * under the upload limit, and naming them would flag the honest majority.
 */
const EDITING_SOFTWARE = /photoshop|gimp|paint\.net|pixlr|canva|affinity|pixelmator|snapseed|picsart|lightroom|sejda|pdf.?escape|pdf.?filler/i;

export function editingSoftware(evidence: CertificateEvidence | null | undefined): string[] {
  return (evidence?.softwareTags ?? []).filter((tag) => EDITING_SOFTWARE.test(tag));
}

type SimpleCheck = { status: CheckStatus; reason: string };

/** Editing software named in the file's metadata. */
export function editingSoftwareCheck(evidence: CertificateEvidence | null | undefined): SimpleCheck & { editors: string[] } {
  const editors = editingSoftware(evidence);
  if (!evidence || evidence.elaApplied === null) {
    return { status: 'skipped', reason: 'Forensics has not run on a certificate for this application.', editors };
  }
  return editors.length > 0
    ? {
        status: 'fail',
        reason: `The file's metadata names editing software (${editors.join(', ')}). Scanners and PDF writers are not counted; these are image and PDF editors.`,
        editors,
      }
    : { status: 'pass', reason: 'No image or PDF editor is named in the file\'s metadata.', editors };
}

/**
 * Error level analysis, scored only when the rule config sets a threshold.
 *
 * v3 sets none, on measurement: on the synthetic corpus ELA separated tampered
 * documents from matched untampered controls no better than chance (AUC 0.50),
 * and at 0.5 it caught 1 of 22 tampered certificates while flagging 9 of 43
 * genuine ones. A signal that fails honest applicants more often than it
 * catches forgeries does not belong in a queue score. The number is still
 * shown, with the regions it found, for a reviewer looking at the document.
 */
export function elaCheck(
  evidence: CertificateEvidence | null | undefined,
  minTamperScore: number | null,
): SimpleCheck & { tamperScore: number | null } {
  const tamperScore = evidence?.tamperScore ?? null;
  if (!evidence || evidence.elaApplied === null) {
    return { status: 'skipped', reason: 'Forensics has not run on a certificate for this application.', tamperScore };
  }
  if (!evidence.elaApplied) {
    return {
      status: 'skipped',
      reason: 'Error level analysis does not apply to this file (not a JPEG or a scanned PDF, or too little print).',
      tamperScore,
    };
  }
  const shown = `Tamper score ${(tamperScore ?? 0).toFixed(2)}`;
  if (minTamperScore === null) {
    return {
      status: 'skipped',
      reason:
        `${shown} — shown for reference, not scored. On the synthetic corpus ELA told tampered from untampered ` +
        'certificates no better than chance (AUC 0.50), so it is not relied on until it is shown to work.',
      tamperScore,
    };
  }
  return (tamperScore ?? 0) >= minTamperScore
    ? { status: 'fail', reason: `${shown}, at or above the ${minTamperScore} threshold: a region compresses unlike the rest of the page.`, tamperScore }
    : { status: 'pass', reason: `${shown}, below the ${minTamperScore} threshold.`, tamperScore };
}

/** Parsed income on the certificate, when it was read well enough to use. */
export function certificateIncomeFrom(evidence: CertificateEvidence | null | undefined) {
  const field = evidence?.fields.annual_income;
  const value = normalizeRupees(field?.value);
  if (value === null || typeof field?.confidence !== 'number') return null;
  return { value, confidence: field.confidence };
}
