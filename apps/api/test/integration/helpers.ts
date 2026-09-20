/**
 * Fixtures for the integration suite.
 *
 * These tests run against a real Postgres with migrations applied, because the
 * behaviour they cover — a unique constraint deciding which of two workers runs
 * a stage, an ON CONFLICT clause making a replay a no-op — exists only in the
 * database. A mocked pg client would assert that the mock behaves as written.
 *
 * Object storage and Redis are NOT required: `processDocument` takes its
 * document loader and OCR client as a context, so both are stubbed here. The
 * database is the only thing with real behaviour worth exercising.
 */

import { randomUUID } from 'node:crypto';

import type { ExtractionPayload, ForensicsPayload } from '../../src/pipeline/ocrClient.js';
import type { StageContext } from '../../src/pipeline/stages.js';
import { pool, query } from '../../src/db.js';

/**
 * Fail loudly rather than skip. A suite that passes because it could not
 * connect is how an unverified claim survives a green build.
 */
export async function requireDatabase(): Promise<void> {
  try {
    await query('SELECT 1');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `The integration suite needs its own Postgres database and could not reach it: ${message}\n` +
        'Create it with `npm run test:integration:setup`.',
    );
  }

  // THE GUARD THAT MATTERS.
  //
  // resetData() truncates. Pointed at a developer's database it truncates the
  // developer's database, which is exactly what happened the first time this
  // suite ran after it was written — a seeded corpus someone was working with,
  // gone, with the tests reporting success.
  //
  // vitest.integration.config.ts rewrites the connection string to a `_test`
  // database before anything reads it. This is the second, independent check
  // that the rewrite took effect, because the first one is a convention and
  // conventions are what get overridden in a hurry.
  const { rows: dbRows } = await query<{ name: string }>('SELECT current_database() AS name');
  const name = dbRows[0]?.name ?? '(unknown)';
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run: connected to "${name}", which is not a test database.\n` +
        'This suite truncates tables. Its database name must end in "_test".\n' +
        'Run `npm run test:integration:setup`, or set TEST_DATABASE_URL.',
    );
  }

  const { rows } = await query<{ present: boolean }>(
    `SELECT to_regclass('pipeline_stage_runs') IS NOT NULL AS present`,
  );
  if (!rows[0]?.present) {
    throw new Error(
      `Migrations have not been applied to "${name}". Run: npm run test:integration:setup`,
    );
  }
}

/**
 * Empty every table these tests write to.
 *
 * `applicants` cascades to applications, documents, stage runs, flags and
 * reviews, so the list is short on purpose — adding a table here that is
 * already reached by cascade is how a truncate starts deleting a user's seeded
 * staff accounts.
 */
export async function resetData(): Promise<void> {
  await query(`TRUNCATE applicants, households, household_edges, tips, audit_log CASCADE`);
}

export interface SeededApplication {
  applicantId: string;
  applicationId: string;
  documentId: string;
}

export interface ApplicationOverrides {
  applicantName?: string;
  guardianName?: string;
  guardianPhone?: string | null;
  addressLine?: string;
  district?: string;
  pincode?: string;
  declaredAnnualIncome?: number;
  declaredFamilySize?: number;
  certificateId?: string | null;
  issuingOffice?: string | null;
  certificateIssueDate?: string | null;
  cycle?: string;
  withDocument?: boolean;
}

let counter = 0;

/** One applicant, one application, and (by default) one uploaded document. */
export async function seedApplication(
  over: ApplicationOverrides = {},
): Promise<SeededApplication> {
  counter += 1;
  const unique = `${counter}-${randomUUID().slice(0, 8)}`;

  const { rows: applicants } = await query<{ id: string }>(
    `INSERT INTO applicants (email, full_name) VALUES ($1, $2) RETURNING id`,
    [`applicant-${unique}@example.test`, over.applicantName ?? `Applicant ${unique}`],
  );
  const applicantId = applicants[0]!.id;

  const { rows: applications } = await query<{ id: string }>(
    `INSERT INTO applications
       (applicant_id, cycle, applicant_name, guardian_name, guardian_phone,
        address_line, district, pincode, declared_annual_income,
        declared_family_size, certificate_id, issuing_office, certificate_issue_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      applicantId,
      over.cycle ?? '2026',
      over.applicantName ?? `Applicant ${unique}`,
      over.guardianName ?? `Guardian ${unique}`,
      over.guardianPhone === undefined ? `98400${String(10000 + counter).slice(-5)}` : over.guardianPhone,
      over.addressLine ?? `${counter} Example Street, Ayanavaram`,
      over.district ?? 'Chennai',
      over.pincode ?? '600023',
      over.declaredAnnualIncome ?? 94_500,
      over.declaredFamilySize ?? 4,
      over.certificateId === undefined ? `TN-CHN-2026-${400_000 + counter}` : over.certificateId,
      over.issuingOffice === undefined ? 'Ayanavaram Taluk Office' : over.issuingOffice,
      over.certificateIssueDate === undefined ? '2026-05-18' : over.certificateIssueDate,
    ],
  );
  const applicationId = applications[0]!.id;

  let documentId = '';
  if (over.withDocument !== false) {
    const { rows: documents } = await query<{ id: string }>(
      `INSERT INTO documents (application_id, storage_key, content_type, byte_size, sha256)
       VALUES ($1, $2, 'image/jpeg', 1024, $3)
       RETURNING id`,
      [applicationId, `test/${unique}.jpg`, randomUUID().replace(/-/g, '')],
    );
    documentId = documents[0]!.id;
  }

  return { applicantId, applicationId, documentId };
}

/* --------------------------------------------------------- stubbed context */

export function extraction(over: Partial<ExtractionPayload> = {}): ExtractionPayload {
  const field = (value: string) => ({ value, confidence: 0.94, box: null });
  return {
    fields: {
      applicant_name: field('Applicant One'),
      guardian_name: field('Guardian One'),
      annual_income: field('94500'),
      annual_income_words: field('Ninety Four Thousand Five Hundred'),
      certificate_id: field('TN-CHN-2026-400001'),
      issue_date: field('2026-05-18'),
      issuing_office: field('Ayanavaram Taluk Office'),
      district: field('Chennai'),
    } as ExtractionPayload['fields'],
    skewCorrectedDegrees: 0,
    pageConfidence: 0.94,
    wordCount: 220,
    incomeWordsMismatch: false,
    ...over,
  };
}

export function forensics(over: Partial<ForensicsPayload> = {}): ForensicsPayload {
  return {
    tamperScore: 0.1,
    regions: [],
    encoding: { format: 'JPEG', width: 1200, height: 1700, quantSignature: null } as ForensicsPayload['encoding'],
    baselineEnergy: 1,
    baselineDeviation: 0,
    notes: [],
    elaApplied: true,
    ...over,
  };
}

export interface StubCounts {
  extract: number;
  forensics: number;
  load: number;
}

/**
 * OCR output for a genuine certificate belonging to a seeded application.
 *
 * Derived from the row rather than hard-coded, because "clean" has to mean the
 * certificate AGREES WITH THE FORM. A fixed set of names would disagree with
 * every generated applicant and fire CERTIFICATE_HOLDER_MISMATCH on documents
 * the test believes are unremarkable — which makes the baseline noisy and every
 * assertion about flags meaningless.
 */
async function genuineExtractionFor(documentId: string): Promise<ExtractionPayload> {
  const { rows } = await query<{
    applicant_name: string;
    guardian_name: string;
    district: string;
    pincode: string | null;
    declared_annual_income: string;
    declared_family_size: number;
    certificate_id: string | null;
    issuing_office: string | null;
    certificate_issue_date: Date | null;
  }>(
    `SELECT a.applicant_name, a.guardian_name, a.district, a.pincode,
            a.declared_annual_income, a.declared_family_size,
            a.certificate_id, a.issuing_office, a.certificate_issue_date
       FROM documents d JOIN applications a ON a.id = d.application_id
      WHERE d.id = $1`,
    [documentId],
  );

  const row = rows[0];
  if (!row) return extraction();

  const income = Number(row.declared_annual_income);
  const field = (value: string | null) => ({ value, confidence: 0.94, box: null });

  return extraction({
    fields: {
      applicant_name: field(row.applicant_name),
      guardian_name: field(row.guardian_name),
      district: field(row.district),
      pincode: field(row.pincode),
      family_size: field(String(row.declared_family_size)),
      annual_income: field(String(income)),
      annual_income_words: field(amountInWords(income)),
      certificate_id: field(row.certificate_id),
      issuing_office: field(row.issuing_office),
      issue_date: field(
        row.certificate_issue_date
          ? new Date(row.certificate_issue_date).toISOString().slice(0, 10)
          : null,
      ),
    } as ExtractionPayload['fields'],
  });
}

/** Enough of Indian numbering for the figures-against-words check to agree. */
function amountInWords(value: number): string {
  const ones = [
    'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen',
    'Nineteen',
  ];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const below100 = (n: number): string =>
    n < 20 ? ones[n]! : `${tens[Math.floor(n / 10)]!}${n % 10 ? ` ${ones[n % 10]!}` : ''}`;
  const below1000 = (n: number): string =>
    n < 100
      ? below100(n)
      : `${ones[Math.floor(n / 100)]!} Hundred${n % 100 ? ` ${below100(n % 100)}` : ''}`;

  const parts: string[] = [];
  const lakh = Math.floor(value / 100_000);
  const thousand = Math.floor((value % 100_000) / 1_000);
  const rest = value % 1_000;

  if (lakh) parts.push(`${below1000(lakh)} Lakh`);
  if (thousand) parts.push(`${below1000(thousand)} Thousand`);
  if (rest) parts.push(below1000(rest));

  return parts.length ? parts.join(' ') : 'Zero';
}

/**
 * A context whose calls are counted.
 *
 * The counts are the point: "the stage did not run twice" is only convincing if
 * you can see that the expensive work behind it was not performed twice either.
 *
 * By default OCR returns a certificate that matches the application it belongs
 * to, so a seeded application is genuinely clean unless a test makes it dirty.
 */
export function stubContext(
  over: { extraction?: ExtractionPayload; forensics?: ForensicsPayload; failExtract?: boolean } = {},
): { ctx: StageContext; counts: StubCounts } {
  const counts: StubCounts = { extract: 0, forensics: 0, load: 0 };

  const ctx: StageContext = {
    loadDocument: async () => {
      counts.load += 1;
      return Buffer.from('not-a-real-image');
    },
    ocr: {
      // stages.ts passes `${documentId}.jpg` as the filename, which is how the
      // stub knows which application's certificate it is pretending to read.
      extract: async (_bytes: Buffer, filename: string) => {
        counts.extract += 1;
        if (over.failExtract) throw new Error('stubbed OCR failure');
        if (over.extraction) return over.extraction;
        return genuineExtractionFor(filename.replace(/\.jpg$/, ''));
      },
      forensics: async () => {
        counts.forensics += 1;
        return over.forensics ?? forensics();
      },
    },
  };

  return { ctx, counts };
}

export async function closePool(): Promise<void> {
  await pool.end();
}
