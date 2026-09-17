/**
 * Loads the synthetic corpus into the running stack.
 *
 *     npm run seed                 # enqueue for `npm run worker`
 *     npm run seed -- --inline     # run the pipeline in this process instead
 *     npm run seed -- --reset      # remove previously seeded data first
 *
 * THROUGH THE PIPELINE, NOT AROUND IT
 * -----------------------------------
 * Writing applications with pre-computed flags would put a working queue on the
 * dashboard and prove nothing. Every seeded application instead gets a rendered,
 * degraded certificate uploaded to object storage and a job on the document
 * queue, so OCR, forensics, verification, household reconciliation and scoring
 * all run exactly as they would for a real upload. If the dashboard shows a
 * flag, the runtime path produced it.
 *
 * WHAT IS LOADED
 * --------------
 * The known and equity cases, into one cycle. The metrics harness evaluates
 * each case in isolation; here all of them share a cycle and can interact,
 * which is closer to how a committee's intake actually looks.
 *
 * The holdout set is NOT loaded. It is spent as an accuracy measure, but it is
 * still the provenance record for the published number, and demo data has no
 * business depending on it.
 *
 * Certificates are the `genuine` variant from `seed:documents` — same renderer,
 * same degradation seed — so the bytes in MinIO match the published corpus.
 */

import { createHash, randomUUID } from 'node:crypto';

import { recordAudit } from '../src/audit.js';
import { hashPassword } from '../src/auth/passwords.js';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db.js';
import { closeQueue, documentQueue, enqueueDocument } from '../src/pipeline/queue.js';
import { processDocument } from '../src/pipeline/worker.js';
import * as storage from '../src/storage.js';
import { renderCertificate } from '../../../db/seed/certificate.js';
import { degrade } from '../../../db/seed/degrade.js';
import { EQUITY_CASES } from '../../../db/seed/patterns.equity.js';
import { KNOWN_CASES } from '../../../db/seed/patterns.known.js';
import type { SeedApplication } from '../../../db/seed/types.js';

/** Seeded applicants are identifiable by domain, which is what `--reset` removes. */
const SYNTHETIC_DOMAIN = 'synthetic.scholarshield.test';

const DEV_PASSWORD = 'scholarshield-dev';

const STAFF = [
  { email: 'reviewer@scholarshield.local', role: 'reviewer' },
  { email: 'admin@scholarshield.local', role: 'admin' },
] as const;

interface SeededApplication {
  applicationId: string;
  documentId: string;
  caseId: string;
  ref: string;
}

const args = new Set(process.argv.slice(2));
const inline = args.has('--inline');
const reset = args.has('--reset');

// ------------------------------------------------------------------ staff

/**
 * Upsert the demo staff accounts.
 *
 * The password is a fixed dev value rather than a generated one, so a reseed
 * does not lock anyone out of a dashboard they already had open. That is only
 * acceptable because this script refuses to run in production.
 */
async function seedStaff(): Promise<void> {
  const password = process.env.SEED_STAFF_PASSWORD ?? DEV_PASSWORD;

  for (const member of STAFF) {
    const { hash, salt } = await hashPassword(password);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO users (email, role, password_hash, password_salt, activated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT ((lower(email))) DO UPDATE
         SET role = EXCLUDED.role,
             password_hash = EXCLUDED.password_hash,
             password_salt = EXCLUDED.password_salt,
             activated_at = coalesce(users.activated_at, now())
       RETURNING id`,
      [member.email, member.role, hash, salt],
    );

    await recordAudit({
      actorId: null,
      actorType: 'system',
      action: 'seed.staff.upserted',
      entityType: 'user',
      entityId: rows[0]!.id,
      detail: { role: member.role },
    });
  }
}

// ------------------------------------------------------------------ reset

async function removeSeededData(): Promise<void> {
  // Bytes first: once the document rows are gone nothing records the keys.
  const { rows: documents } = await query<{ storage_key: string }>(
    `SELECT d.storage_key
       FROM documents d
       JOIN applications a ON a.id = d.application_id
       JOIN applicants p ON p.id = a.applicant_id
      WHERE p.email LIKE $1`,
    [`%@${SYNTHETIC_DOMAIN}`],
  );
  for (const document of documents) {
    await storage.remove(document.storage_key);
  }

  // Applications, documents, stage runs, edges, flags, reviews and verification
  // results all cascade from the applicant. The audit log does not, by design.
  const { rowCount } = await query(`DELETE FROM applicants WHERE email LIKE $1`, [
    `%@${SYNTHETIC_DOMAIN}`,
  ]);
  await query(
    `DELETE FROM households h
      WHERE NOT EXISTS (SELECT 1 FROM applications a WHERE a.household_id = h.id)`,
  );
  await documentQueue().obliterate({ force: true });

  console.log(`  removed ${rowCount ?? 0} seeded applicant(s) and ${documents.length} document(s)`);
}

// ------------------------------------------------------------ applications

async function seedApplication(caseId: string, app: SeedApplication): Promise<SeededApplication> {
  const email = `${caseId}.${app.ref}@${SYNTHETIC_DOMAIN}`.toLowerCase();

  const { rows: applicants } = await query<{ id: string }>(
    `INSERT INTO applicants (email, full_name) VALUES ($1, $2) RETURNING id`,
    [email, app.applicantName],
  );
  const applicantId = applicants[0]!.id;

  const { rows: applications } = await query<{ id: string }>(
    `INSERT INTO applications
       (applicant_id, cycle, applicant_name, guardian_name, guardian_phone,
        address_line, district, pincode, declared_annual_income,
        declared_family_size, certificate_id, issuing_office,
        certificate_issue_date, submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      applicantId,
      app.cycle,
      app.applicantName,
      app.guardianName,
      app.guardianPhone,
      app.addressLine,
      app.district,
      app.pincode,
      app.declaredAnnualIncome,
      app.declaredFamilySize,
      app.certificateId,
      app.issuingOffice,
      app.certificateIssueDate,
      app.applicationDate,
    ],
  );
  const applicationId = applications[0]!.id;

  // Same seed as the `genuine` variant in seed-documents.ts, so these bytes are
  // the published corpus rather than a lookalike of it.
  const rendered = renderCertificate(app);
  const { jpeg } = await degrade(rendered.png, { seed: `${caseId}__${app.ref}` });

  const documentId = randomUUID();
  const contentType = 'image/jpeg';
  const storageKey = storage.storageKeyFor(documentId, contentType);
  await storage.put(storageKey, jpeg, contentType);

  await query(
    `INSERT INTO documents (id, application_id, storage_key, content_type, byte_size, sha256)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      documentId,
      applicationId,
      storageKey,
      contentType,
      jpeg.length,
      createHash('sha256').update(jpeg).digest('hex'),
    ],
  );

  await recordAudit({
    actorId: null,
    actorType: 'system',
    action: 'seed.application.created',
    entityType: 'application',
    entityId: applicationId,
    detail: { caseId, ref: app.ref },
  });

  return { applicationId, documentId, caseId, ref: app.ref };
}

// ------------------------------------------------------------------ report

/**
 * Compare what the runtime path flagged against what each case expects.
 *
 * Only meaningful after `--inline`, when every document has been processed. It
 * checks the same two properties the test suites do — known cases surface,
 * equity cases never reach high severity — but against rows the pipeline wrote,
 * with every case sharing one cycle.
 */
async function report(seeded: SeededApplication[]): Promise<void> {
  const { rows } = await query<{ application_id: string; severity: string }>(
    `SELECT application_id, severity FROM risk_flags WHERE application_id = ANY($1::uuid[])`,
    [seeded.map((s) => s.applicationId)],
  );

  const flagged = new Set(rows.map((r) => r.application_id));
  const high = new Set(rows.filter((r) => r.severity === 'high').map((r) => r.application_id));
  const idFor = (caseId: string, ref: string) =>
    seeded.find((s) => s.caseId === caseId && s.ref === ref)?.applicationId;

  const missed: string[] = [];
  let expected = 0;
  for (const knownCase of KNOWN_CASES) {
    for (const ref of knownCase.shouldFlag) {
      expected += 1;
      const id = idFor(knownCase.id, ref);
      if (!id || !flagged.has(id)) missed.push(`${knownCase.id}::${ref}`);
    }
  }

  const equityHigh: string[] = [];
  for (const equityCase of EQUITY_CASES) {
    for (const app of equityCase.applications) {
      const id = idFor(equityCase.id, app.ref);
      if (id && high.has(id)) equityHigh.push(`${equityCase.id}::${app.ref}`);
    }
  }

  console.log('\nruntime path vs expectations');
  console.log(`  known surfaced   ${expected - missed.length}/${expected}`);
  for (const m of missed) console.log(`    missed: ${m}`);
  console.log(`  equity high      ${equityHigh.length} (must be 0)`);
  for (const e of equityHigh) console.log(`    high: ${e}`);
}

// ------------------------------------------------------------------- main

async function main(): Promise<void> {
  if (config.NODE_ENV === 'production') {
    console.error('Refusing to seed a production database.');
    process.exit(1);
  }

  console.log('scholarshield seed\n');

  if (reset) await removeSeededData();

  const { rows } = await query<{ count: string }>(`SELECT count(*) FROM applications`);
  if (Number(rows[0]!.count) > 0) {
    console.error(
      `The database already holds ${rows[0]!.count} application(s). ` +
        'Run `npm run seed -- --reset` to replace the seeded corpus.',
    );
    process.exitCode = 1;
    return;
  }

  await seedStaff();
  console.log(`  staff            ${STAFF.map((s) => s.email).join(', ')}`);

  // Arrival order, so households assemble the way intake would build them.
  const cases = [...KNOWN_CASES, ...EQUITY_CASES];
  const ordered = cases
    .flatMap((c) => c.applications.map((app) => ({ caseId: c.id, app })))
    .sort((a, b) => a.app.applicationDate.localeCompare(b.app.applicationDate));

  const seeded: SeededApplication[] = [];
  for (const { caseId, app } of ordered) {
    seeded.push(await seedApplication(caseId, app));
  }
  console.log(`  applications     ${seeded.length} across ${cases.length} cases`);

  if (inline) {
    for (const [index, s] of seeded.entries()) {
      const outcome = await processDocument({
        documentId: s.documentId,
        applicationId: s.applicationId,
      });
      const state = outcome.stoppedAt ? `stopped at ${outcome.stoppedAt}` : 'complete';
      console.log(`  [${index + 1}/${seeded.length}] ${s.caseId}::${s.ref} ${state}`);
    }
    await report(seeded);
  } else {
    for (const s of seeded) {
      await enqueueDocument({ documentId: s.documentId, applicationId: s.applicationId });
    }
    console.log(`  enqueued         ${seeded.length} document(s) — start \`npm run worker\``);
  }

  console.log(
    `\nSign in with either staff email and password ` +
      `${process.env.SEED_STAFF_PASSWORD ? '$SEED_STAFF_PASSWORD' : `\`${DEV_PASSWORD}\``}.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueue();
    await closePool();
  });
