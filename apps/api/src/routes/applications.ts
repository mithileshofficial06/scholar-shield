import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';

import type { HouseholdView } from '@scholarshield/shared';

import { recordAudit } from '../audit.js';
import { requireApplicant, requireStaff } from '../auth/middleware.js';
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { applicationChecklist, reconcileCycle, scoreApplications } from '../household/service.js';
import { enqueueDocument } from '../pipeline/queue.js';
import {
  toApplicationDetail,
  toHouseholdEdge,
  toReviewRecord,
  toVerificationResult,
  type EdgeRow,
  type FlagRow,
  type FullApplicationRow,
  type ReviewRow,
  type VerificationRow,
  type DocumentRow as DetailDocumentRow,
} from '../reviewerSerializers.js';
import { toApplicantView, type ApplicationRow } from '../serializers.js';
import * as storage from '../storage.js';
import { sniffContentType } from '../uploads.js';

export const applicationsRouter = Router();

/* ------------------------------------------------------------- applicant */

/**
 * Applicant-facing: only ever the caller's own applications, and only through
 * toApplicantView, which constructs its output field by field.
 */
applicationsRouter.get('/mine', requireApplicant, async (req, res) => {
  const applicantId = req.session!.sub;

  const { rows } = await query<ApplicationRow & { document_count: string }>(
    `SELECT a.id, a.cycle, a.status, a.submitted_at,
            count(d.id)::text AS document_count
       FROM applications a
       LEFT JOIN documents d ON d.application_id = a.id
      WHERE a.applicant_id = $1
      GROUP BY a.id
      ORDER BY a.submitted_at DESC`,
    [applicantId],
  );

  res.json(rows.map((row) => toApplicantView(row, Number(row.document_count))));
});

/* -------------------------------------------------------------- submission */

const upload = multer({
  // Memory, not disk: the bytes go straight to object storage, and a temp file
  // on the API host is one more copy of a document to have to purge later.
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 },
});

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many submissions from this address.' },
});

/** Numbers arrive as strings in multipart form data. */
const numeric = (schema: z.ZodNumber) =>
  z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(schema);

const submitSchema = z.object({
  email: z.string().email(),
  applicantName: z.string().min(2).max(120),
  guardianName: z.string().min(2).max(120),
  // Messages on the format checks: without one, zod says only "Invalid", and the
  // apply form shows these to the applicant beside the field.
  guardianPhone: z
    .string()
    .regex(/^\d{10}$/, 'Enter a 10-digit mobile number, digits only.')
    .optional()
    .or(z.literal('')),
  addressLine: z.string().min(4).max(240),
  district: z.string().min(2).max(80),
  pincode: z.string().regex(/^\d{6}$/, 'Enter a 6-digit PIN code.').optional().or(z.literal('')),
  declaredAnnualIncome: numeric(z.number().int().min(0).max(100_000_000)),
  declaredFamilySize: numeric(z.number().int().min(1).max(30)),
  certificateId: z.string().max(60).optional().or(z.literal('')),
  issuingOffice: z.string().max(120).optional().or(z.literal('')),
  certificateIssueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.')
    .optional()
    .or(z.literal('')),
  cycle: z.string().regex(/^\d{4}$/, 'The cycle is a four-digit year.').optional(),
});

const blank = (value: string | undefined) => (value === undefined || value === '' ? null : value);

/** The one-application-per-person index (migration 003) refused the insert. */
function isDuplicateApplication(err: unknown): boolean {
  const pg = err as { code?: string; constraint?: string } | null;
  return pg?.code === '23505' && pg.constraint === 'applications_one_per_person_idx';
}

/**
 * Submit an application.
 *
 * Public by design — an applicant has no account until they submit, and
 * requiring one first would put the sign-in wall in front of the only action
 * that creates the account. Abuse is bounded by the rate limiter, and the
 * response carries only what toApplicantView allows: no score, no flag, ever.
 *
 * The uploaded certificate is sniffed by magic bytes rather than trusted by its
 * declared type (PROJECT_REPORT.md §11) and is parsed only inside the isolated
 * Python service, never here.
 */
applicationsRouter.post('/', submitLimiter, upload.single('certificate'), async (req, res) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Some fields need attention.',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const file = req.file;
  let contentType: string | null = null;
  if (file) {
    contentType = sniffContentType(file.buffer);
    if (!contentType) {
      res.status(415).json({
        error: 'unsupported_media_type',
        message: 'The certificate must be a JPEG, PNG, WebP or PDF.',
      });
      return;
    }
  }

  const input = parsed.data;
  const cycle = input.cycle ?? config.CURRENT_CYCLE;

  const created = await withTransaction(async (client) => {
    const { rows: applicants } = await client.query<{ id: string }>(
      `INSERT INTO applicants (email, full_name)
       VALUES ($1, $2)
       ON CONFLICT (lower(email)) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING id`,
      [input.email, input.applicantName],
    );
    const applicantId = applicants[0]!.id;

    const { rows: applications } = await client.query<ApplicationRow>(
      `INSERT INTO applications
         (applicant_id, cycle, applicant_name, guardian_name, guardian_phone,
          address_line, district, pincode, declared_annual_income,
          declared_family_size, certificate_id, issuing_office, certificate_issue_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, cycle, status, submitted_at`,
      [
        applicantId,
        cycle,
        input.applicantName,
        input.guardianName,
        blank(input.guardianPhone),
        input.addressLine,
        input.district,
        blank(input.pincode),
        input.declaredAnnualIncome,
        input.declaredFamilySize,
        blank(input.certificateId),
        blank(input.issuingOffice),
        blank(input.certificateIssueDate),
      ],
    );
    const application = applications[0]!;

    let documentId: string | null = null;
    if (file && contentType) {
      documentId = randomUUID();
      const storageKey = storage.storageKeyFor(documentId, contentType);
      // Uploaded before the row is committed: a stored object with no row is
      // collectable garbage, while a row pointing at bytes that never arrived
      // would dead-letter the pipeline on every retry.
      await storage.put(storageKey, file.buffer, contentType);
      await client.query(
        `INSERT INTO documents (id, application_id, storage_key, content_type, byte_size, sha256)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [documentId, application.id, storageKey, contentType, file.size, storage.sha256(file.buffer)],
      );
    }

    await recordAudit(
      {
        actorId: applicantId,
        actorType: 'applicant',
        action: 'application.submitted',
        entityType: 'application',
        entityId: application.id,
        detail: { cycle, withDocument: documentId !== null },
      },
      client,
    );

    return { application, documentId };
  }).catch((err: unknown) => {
    // The whole transaction rolled back, the account upsert included, and the
    // certificate upload comes after the insert that failed — nothing to clean up.
    if (isDuplicateApplication(err)) return null;
    throw err;
  });

  if (!created) {
    res.status(409).json({
      error: 'already_applied',
      message:
        `An application for ${input.applicantName} under this email already exists for the ${cycle} cycle. ` +
        'Check its status with a sign-in link instead of applying again.',
    });
    return;
  }

  if (created.documentId) {
    await enqueueDocument({ documentId: created.documentId, applicationId: created.application.id });
  }

  res.status(201).json(toApplicantView(created.application, created.documentId ? 1 : 0));
});

/* ------------------------------------------------------------------ staff */

const idParam = z.object({ id: z.string().uuid() });

async function loadDetail(id: string) {
  const { rows } = await query<FullApplicationRow>(
    `SELECT id, cycle, status, applicant_name, guardian_name, guardian_phone,
            address_line, district, pincode, declared_annual_income,
            declared_family_size, certificate_id, issuing_office,
            certificate_issue_date, risk_score, scored_at, submitted_at, household_id
       FROM applications WHERE id = $1`,
    [id],
  );
  const application = rows[0];
  if (!application) return null;

  const [flags, documents, verification, household] = await Promise.all([
    query<FlagRow>(
      `SELECT id, application_id, rule_id, rule_config_version, severity, weight,
              reason, evidence, created_at
         FROM risk_flags WHERE application_id = $1
        ORDER BY weight DESC, created_at ASC`,
      [id],
    ),
    query<DetailDocumentRow>(
      `SELECT id, kind, content_type, byte_size, sha256, extracted_fields,
              tamper_score, purged_at
         FROM documents WHERE application_id = $1 ORDER BY created_at ASC`,
      [id],
    ),
    query<VerificationRow>(
      `SELECT id, application_id, adapter, status, manual_check_url, checked_at, notes
         FROM verification_results WHERE application_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [id],
    ),
    loadHousehold(application.household_id),
  ]);

  return toApplicationDetail({
    application,
    flags: flags.rows,
    documents: documents.rows,
    verification: verification.rows[0] ?? null,
    household,
  });
}

async function loadHousehold(householdId: string | null) {
  if (!householdId) return null;

  const { rows: households } = await query<{ id: string; cycle: string; member_count: number }>(
    `SELECT id, cycle, member_count FROM households WHERE id = $1`,
    [householdId],
  );
  const household = households[0];
  if (!household) return null;

  const { rows: members } = await query<{ id: string }>(
    `SELECT id FROM applications WHERE household_id = $1 ORDER BY submitted_at ASC`,
    [householdId],
  );
  const applicationIds = members.map((m) => m.id);

  const { rows: edges } = await query<EdgeRow>(
    `SELECT id, application_a_id, application_b_id, match_field, similarity, weight,
            rejected_at, rejected_reason
       FROM household_edges
      WHERE application_a_id = ANY($1::uuid[]) AND application_b_id = ANY($1::uuid[])
      ORDER BY weight DESC`,
    [applicationIds],
  );

  return {
    id: household.id,
    cycle: household.cycle,
    memberCount: household.member_count,
    applicationIds,
    edges,
  };
}

/** Full reviewer view of one application. */
applicationsRouter.get('/:id', requireStaff(), async (req, res) => {
  const parsed = idParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'Bad application id.' });
    return;
  }

  const detail = await loadDetail(parsed.data.id);
  if (!detail) {
    res.status(404).json({ error: 'not_found', message: 'No such application.' });
    return;
  }

  res.json(detail);
});

/**
 * The household graph behind an application.
 *
 * Returns rejected edges too. A reviewer needs to see that a merge was declined
 * — and by implication that it can be restored — rather than watch it silently
 * disappear from the picture.
 */
applicationsRouter.get('/:id/household', requireStaff(), async (req, res) => {
  const parsed = idParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'Bad application id.' });
    return;
  }

  const { rows } = await query<{ household_id: string | null }>(
    `SELECT household_id FROM applications WHERE id = $1`,
    [parsed.data.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'not_found', message: 'No such application.' });
    return;
  }

  const household = await loadHousehold(rows[0]!.household_id);
  const ids = household?.applicationIds ?? [parsed.data.id];

  const { rows: members } = await query<{
    id: string;
    applicant_name: string;
    guardian_name: string;
    district: string;
    declared_annual_income: string;
    declared_family_size: number;
    risk_score: string;
    status: HouseholdView['members'][number]['status'];
  }>(
    `SELECT id, applicant_name, guardian_name, district, declared_annual_income,
            declared_family_size, risk_score, status
       FROM applications WHERE id = ANY($1::uuid[])
      ORDER BY risk_score DESC`,
    [ids],
  );

  const view: HouseholdView = {
    household: household
      ? {
          id: household.id,
          cycle: household.cycle,
          memberCount: household.memberCount,
          applicationIds: household.applicationIds,
          edges: household.edges.map(toHouseholdEdge),
        }
      : null,
    members: members.map((m) => ({
      id: m.id,
      applicantName: m.applicant_name,
      guardianName: m.guardian_name,
      district: m.district,
      declaredAnnualIncome: Number(m.declared_annual_income),
      declaredFamilySize: m.declared_family_size,
      riskScore: Number(m.risk_score),
      status: m.status,
    })),
    edges: (household?.edges ?? []).map(toHouseholdEdge),
  };

  res.json(view);
});

/* ---------------------------------------------------------- the checklist */

/**
 * Every check on this application — passed, failed, skipped with its reason, or
 * pending. Staff only: a pass list tells an applicant what the engine looks at,
 * which is exactly what a fraudulent one would like to know.
 */
applicationsRouter.get('/:id/checks', requireStaff(), async (req, res) => {
  const parsed = idParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'Bad application id.' });
    return;
  }

  const checklist = await applicationChecklist(parsed.data.id);
  if (!checklist) {
    res.status(404).json({ error: 'not_found', message: 'No such application.' });
    return;
  }
  res.json(checklist);
});

/* ------------------------------------------------------ government record */

const verificationSchema = z.object({
  // manual_check_required is where a result starts, not something to record.
  status: z.enum(['verified', 'mismatch', 'unavailable']),
  notes: z.string().trim().max(2000).optional(),
});

/**
 * Record what the reviewer found on the state verification portal.
 *
 * Appended, never updated: the latest row is the current result and earlier
 * ones stay as history, the same as decisions. A mismatch must say what did not
 * match — it moves the application up the queue, so the next reviewer needs to
 * know why. The cycle is rescored because GOVERNMENT_RECORD_MISMATCH reads this.
 */
applicationsRouter.post('/:id/verification', requireStaff(), async (req, res) => {
  const params = idParam.safeParse(req.params);
  const body = verificationSchema.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'A status of verified, mismatch or unavailable is required.',
      details: body.success ? undefined : body.error.flatten().fieldErrors,
    });
    return;
  }
  const { status, notes } = body.data;
  if (status === 'mismatch' && (!notes || notes.length < 12)) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Say what did not match (at least 12 characters): it raises this application in the queue.',
    });
    return;
  }

  const reviewerId = req.session!.sub;
  const recorded = await withTransaction(async (client) => {
    const { rows } = await client.query<{ cycle: string; manual_check_url: string | null }>(
      `SELECT a.cycle,
              (SELECT manual_check_url FROM verification_results v
                WHERE v.application_id = a.id ORDER BY created_at DESC LIMIT 1) AS manual_check_url
         FROM applications a WHERE a.id = $1`,
      [params.data.id],
    );
    const application = rows[0];
    if (!application) return null;
    if (!application.manual_check_url) return { cycle: application.cycle, noLink: true as const };

    const { rows: inserted } = await client.query<VerificationRow>(
      `INSERT INTO verification_results
         (application_id, adapter, status, manual_check_url, checked_by, checked_at, notes)
       VALUES ($1, 'ManualLinkAdapter', $2, $3, $4, now(), $5)
       RETURNING id, application_id, adapter, status, manual_check_url, checked_at, notes`,
      [params.data.id, status, application.manual_check_url, reviewerId, notes ?? null],
    );

    await recordAudit(
      {
        actorId: reviewerId,
        actorType: 'user',
        action: 'verification.recorded',
        entityType: 'application',
        entityId: params.data.id,
        detail: { status, notes: notes ?? null },
      },
      client,
    );
    return { cycle: application.cycle, row: inserted[0]! };
  });

  if (!recorded) {
    res.status(404).json({ error: 'not_found', message: 'No such application.' });
    return;
  }
  if ('noLink' in recorded) {
    res.status(409).json({
      error: 'not_ready',
      message: 'This application has no verification link yet — its certificate has not been processed.',
    });
    return;
  }

  await rescoreCycle(recorded.cycle, reviewerId);
  res.status(201).json(toVerificationResult(recorded.row));
});

/* ---------------------------------------------------------------- decision */

const reviewSchema = z.object({
  decision: z.enum(['approve', 'escalate', 'reject', 'trash']),
  // Long enough to be a reason rather than a shrug. The database also refuses
  // an empty string, so this is the friendly half of the same rule.
  reason: z.string().trim().min(12).max(2000),
});

/**
 * Record a reviewer's decision.
 *
 * This is the only path to a terminal status. The score is not consulted here
 * and no branch reads it: what moves an application out of the queue is a
 * reviewer id and a written reason, both of which land in the audit log.
 */
applicationsRouter.post('/:id/review', requireStaff(), async (req, res) => {
  const params = idParam.safeParse(req.params);
  const body = reviewSchema.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'A decision and a reason of at least 12 characters are required.',
      details: body.success ? undefined : body.error.flatten().fieldErrors,
    });
    return;
  }

  const reviewerId = req.session!.sub;
  const { decision, reason } = body.data;
  const nextStatus =
    decision === 'approve'
      ? 'approved'
      : decision === 'reject'
        ? 'rejected'
        : decision === 'trash'
          ? 'trashed'
          : 'escalated';

  const outcome = await withTransaction(async (client) => {
    // Lock the row so two reviewers cannot decide the same application at once.
    const { rows } = await client.query<{ status: string }>(
      `SELECT status FROM applications WHERE id = $1 FOR UPDATE`,
      [params.data.id],
    );
    const current = rows[0];
    if (!current) return { kind: 'not_found' as const };

    // Escalated is deliberately not terminal: it means "someone senior should
    // look", and that person still has to decide. Trashed is terminal — if it
    // turns out a real application was binned, the applicant reapplies, which
    // is the same remedy an erroneous rejection has.
    if (
      current.status === 'approved' ||
      current.status === 'rejected' ||
      current.status === 'trashed'
    ) {
      return { kind: 'already_decided' as const, status: current.status };
    }

    const { rows: reviews } = await client.query<ReviewRow>(
      `INSERT INTO reviews (application_id, reviewer_id, decision, reason)
       VALUES ($1, $2, $3, $4)
       RETURNING id, application_id, reviewer_id, decision, reason, created_at`,
      [params.data.id, reviewerId, decision, reason],
    );

    await client.query(`UPDATE applications SET status = $2 WHERE id = $1`, [
      params.data.id,
      nextStatus,
    ]);

    await recordAudit(
      {
        actorId: reviewerId,
        actorType: 'user',
        action: `review.${decision}`,
        entityType: 'application',
        entityId: params.data.id,
        detail: { decision, reason, previousStatus: current.status },
      },
      client,
    );

    return { kind: 'ok' as const, review: reviews[0]! };
  });

  if (outcome.kind === 'not_found') {
    res.status(404).json({ error: 'not_found', message: 'No such application.' });
    return;
  }
  if (outcome.kind === 'already_decided') {
    res.status(409).json({
      error: 'already_decided',
      message: `This application was already ${outcome.status}. Decisions are append-only.`,
    });
    return;
  }

  res.status(201).json(toReviewRecord(outcome.review));
});

/** Decision history. Append-only, so this is the full record, not the latest. */
applicationsRouter.get('/:id/reviews', requireStaff(), async (req, res) => {
  const parsed = idParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'Bad application id.' });
    return;
  }

  const { rows } = await query<ReviewRow & { reviewer_email: string }>(
    `SELECT r.id, r.application_id, r.reviewer_id, r.decision, r.reason, r.created_at,
            u.email AS reviewer_email
       FROM reviews r JOIN users u ON u.id = r.reviewer_id
      WHERE r.application_id = $1
      ORDER BY r.created_at DESC`,
    [parsed.data.id],
  );

  res.json({
    items: rows.map((row) => ({ ...toReviewRecord(row), reviewerEmail: row.reviewer_email })),
  });
});

/* ------------------------------------------------------- rescore a cycle */

/**
 * Re-resolve and re-score a whole cycle.
 *
 * Needed after an import, and after a reviewer rejects a merge: membership can
 * change anywhere in the cycle, so every application is rescored rather than
 * guessing which ones moved.
 */
export async function rescoreCycle(cycle: string, actorId: string | null) {
  const reconcile = await reconcileCycle(cycle, null);
  const scored = await scoreApplications(cycle, reconcile.rescore, {
    actorId,
    actorType: actorId ? 'user' : 'system',
    entityType: 'cycle',
    entityId: cycle,
  });
  return { reconcile, scored };
}
