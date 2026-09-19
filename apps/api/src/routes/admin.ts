/**
 * Administration: who may review, what is in each cycle, and bulk intake.
 *
 * Everything here is admin-only except the cycle list, which any reviewer needs
 * in order to filter their own queue.
 *
 * WHY RULE CONFIG IS READ-ONLY HERE
 * ---------------------------------
 * `config/rules.<version>.json` is checked into the repository and its version is
 * stamped onto every risk_flags row, which is what makes a historical score
 * reproducible against the configuration that produced it (§5, §11). An endpoint
 * that edited weights in place would silently change what past flags meant, so
 * this exposes the active configuration and its provenance and nothing more. A
 * weight change is a new version file and a deployment, on purpose.
 */

import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';

import type { CycleSummary, StaffUser } from '@scholarshield/shared';

import { recordAudit } from '../audit.js';
import { requireStaff } from '../auth/middleware.js';
import { createMagicLinkToken, hashToken } from '../auth/tokens.js';
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { loadRulesConfig } from '../household/config.js';
import { inviteMessage, sendMail } from '../mail.js';
import { rescoreCycle } from './applications.js';

export const adminRouter = Router();

const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());

interface UserRow {
  id: string;
  email: string;
  role: StaffUser['role'];
  activated_at: Date | null;
  invited_by: string | null;
  invite_expires_at: Date | null;
  created_at: Date;
}

const toStaffUser = (row: UserRow): StaffUser => ({
  id: row.id,
  email: row.email,
  role: row.role,
  activatedAt: iso(row.activated_at),
  invitedBy: row.invited_by,
  inviteExpiresAt: iso(row.invite_expires_at),
  createdAt: new Date(row.created_at).toISOString(),
});

/* ------------------------------------------------------------------ users */

adminRouter.get('/users', requireStaff('admin'), async (_req, res) => {
  const { rows } = await query<UserRow>(
    `SELECT id, email, role, activated_at, invited_by, invite_expires_at, created_at
       FROM users ORDER BY created_at ASC`,
  );
  res.json({ items: rows.map(toStaffUser) });
});

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['reviewer', 'admin']),
});

/**
 * Invite a reviewer.
 *
 * The invitation token is stored hashed, exactly like an applicant's magic
 * link: a database read must not mint a working credential. The invitee sets
 * their own password, so no one — including this endpoint — ever knows it.
 */
adminRouter.post('/users/invite', requireStaff('admin'), async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'A valid email and role are required.' });
    return;
  }

  const actorId = req.session!.sub;
  const { token, tokenHash } = createMagicLinkToken();
  const expiresAt = new Date(Date.now() + config.INVITE_TTL_DAYS * 86_400_000);

  const existing = await query<{ activated_at: Date | null }>(
    `SELECT activated_at FROM users WHERE lower(email) = lower($1)`,
    [parsed.data.email],
  );
  if (existing.rows[0]?.activated_at) {
    res.status(409).json({ error: 'already_active', message: 'That address already has an account.' });
    return;
  }

  const { rows } = await query<UserRow>(
    `INSERT INTO users (email, role, invited_by, invite_token, invite_expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ((lower(email))) DO UPDATE
       SET role = EXCLUDED.role,
           invited_by = EXCLUDED.invited_by,
           invite_token = EXCLUDED.invite_token,
           invite_expires_at = EXCLUDED.invite_expires_at
     RETURNING id, email, role, activated_at, invited_by, invite_expires_at, created_at`,
    [parsed.data.email, parsed.data.role, actorId, tokenHash, expiresAt],
  );

  const delivery = await sendMail(inviteMessage(parsed.data.email, token, parsed.data.role));

  await recordAudit({
    actorId,
    actorType: 'user',
    action: 'user.invited',
    entityType: 'user',
    entityId: rows[0]!.id,
    detail: { email: parsed.data.email, role: parsed.data.role, delivery: delivery.via },
  });

  const body: Record<string, unknown> = { user: toStaffUser(rows[0]!), delivery: delivery.via };
  // Same reasoning as the applicant magic link: only when mail has nowhere to
  // go, and never in production.
  if (config.NODE_ENV !== 'production' && delivery.via === 'log') body.devToken = token;

  res.status(201).json(body);
});

/** Withdraw an invitation that has not been accepted. */
adminRouter.delete('/users/:id/invite', requireStaff('admin'), async (req, res) => {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'Bad user id.' });
    return;
  }

  const { rowCount } = await query(
    `DELETE FROM users WHERE id = $1 AND activated_at IS NULL`,
    [parsed.data.id],
  );
  if (rowCount === 0) {
    res.status(409).json({
      error: 'not_pending',
      message: 'Only an invitation that has not been accepted can be withdrawn.',
    });
    return;
  }

  await recordAudit({
    actorId: req.session!.sub,
    actorType: 'user',
    action: 'user.invite_withdrawn',
    entityType: 'user',
    entityId: parsed.data.id,
  });

  res.json({ status: 'withdrawn' });
});

/* ----------------------------------------------------------------- cycles */

adminRouter.get('/cycles', requireStaff(), async (_req, res) => {
  const { rows } = await query<{
    cycle: string;
    applications: string;
    awaiting_review: string;
    decided: string;
    flagged: string;
  }>(
    `SELECT a.cycle,
            count(*)::text AS applications,
            count(*) FILTER (WHERE a.status IN ('ready_for_review', 'escalated'))::text AS awaiting_review,
            count(*) FILTER (WHERE a.status IN ('approved', 'rejected'))::text AS decided,
            count(DISTINCT f.application_id)::text AS flagged
       FROM applications a
       LEFT JOIN risk_flags f ON f.application_id = a.id
      GROUP BY a.cycle
      ORDER BY a.cycle DESC`,
  );

  const items: CycleSummary[] = rows.map((row) => ({
    cycle: row.cycle,
    applications: Number(row.applications),
    awaitingReview: Number(row.awaiting_review),
    decided: Number(row.decided),
    flagged: Number(row.flagged),
  }));

  res.json({ items, current: config.CURRENT_CYCLE });
});

/* ----------------------------------------------------------------- import */

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

const rowSchema = z.object({
  email: z.string().email(),
  applicantName: z.string().min(2).max(120),
  guardianName: z.string().min(2).max(120),
  guardianPhone: z.string().regex(/^\d{10}$/).optional().or(z.literal('')),
  addressLine: z.string().min(4).max(240),
  district: z.string().min(2).max(80),
  pincode: z.string().regex(/^\d{6}$/).optional().or(z.literal('')),
  declaredAnnualIncome: z.coerce.number().int().min(0).max(100_000_000),
  declaredFamilySize: z.coerce.number().int().min(1).max(30),
  certificateId: z.string().max(60).optional().or(z.literal('')),
  issuingOffice: z.string().max(120).optional().or(z.literal('')),
  certificateIssueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
});

const blank = (value: string | undefined) => (value === undefined || value === '' ? null : value);

export const IMPORT_COLUMNS = Object.keys(rowSchema.shape);

/**
 * Bulk intake from a spreadsheet.
 *
 * Committees already hold their applicants in a spreadsheet, and asking someone
 * to retype three hundred rows into a web form is how a tool goes unused. Rows
 * arrive without certificates: the household engine needs no document, so the
 * cycle is reconciled and scored directly once the rows land.
 *
 * The whole file is validated before anything is written. A half-imported cycle
 * would produce household resolutions over a partial population, which is worse
 * than a rejected file because it looks like it worked.
 */
adminRouter.post('/import', requireStaff('admin'), importUpload.single('file'), async (req, res) => {
  const cycle = z.string().regex(/^\d{4}$/).safeParse(req.body?.cycle ?? config.CURRENT_CYCLE);
  if (!req.file || !cycle.success) {
    res.status(400).json({ error: 'invalid_request', message: 'A CSV file and a four-digit cycle are required.' });
    return;
  }

  let records: Record<string, string>[];
  try {
    records = parse(req.file.buffer, {
      columns: (header: string[]) => header.map((name) => name.trim()),
      skip_empty_lines: true,
      trim: true,
      bom: true,
    }) as Record<string, string>[];
  } catch (err) {
    res.status(400).json({
      error: 'unparseable_csv',
      message: err instanceof Error ? err.message : 'The file could not be read as CSV.',
    });
    return;
  }

  if (records.length === 0) {
    res.status(400).json({ error: 'empty_file', message: 'That file has no data rows.' });
    return;
  }
  if (records.length > 2000) {
    res.status(413).json({ error: 'too_many_rows', message: 'Import at most 2000 rows at a time.' });
    return;
  }

  const rows: z.infer<typeof rowSchema>[] = [];
  const errors: { row: number; issues: Record<string, string[] | undefined> }[] = [];

  records.forEach((record, index) => {
    const parsed = rowSchema.safeParse(record);
    if (parsed.success) rows.push(parsed.data);
    // +2: one for the header line, one because humans count from 1.
    else errors.push({ row: index + 2, issues: parsed.error.flatten().fieldErrors });
  });

  if (errors.length > 0) {
    res.status(422).json({
      error: 'invalid_rows',
      message: `${errors.length} of ${records.length} rows could not be imported. Nothing was saved.`,
      details: errors.slice(0, 20),
      expectedColumns: IMPORT_COLUMNS,
    });
    return;
  }

  const actorId = req.session!.sub;

  const created = await withTransaction(async (client) => {
    const ids: string[] = [];
    for (const row of rows) {
      const { rows: applicants } = await client.query<{ id: string }>(
        `INSERT INTO applicants (email, full_name)
         VALUES ($1, $2)
         ON CONFLICT (lower(email)) DO UPDATE SET full_name = EXCLUDED.full_name
         RETURNING id`,
        [row.email, row.applicantName],
      );

      const { rows: applications } = await client.query<{ id: string }>(
        `INSERT INTO applications
           (applicant_id, cycle, applicant_name, guardian_name, guardian_phone,
            address_line, district, pincode, declared_annual_income,
            declared_family_size, certificate_id, issuing_office, certificate_issue_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
        [
          applicants[0]!.id,
          cycle.data,
          row.applicantName,
          row.guardianName,
          blank(row.guardianPhone),
          row.addressLine,
          row.district,
          blank(row.pincode),
          row.declaredAnnualIncome,
          row.declaredFamilySize,
          blank(row.certificateId),
          blank(row.issuingOffice),
          blank(row.certificateIssueDate),
        ],
      );
      ids.push(applications[0]!.id);
    }

    await recordAudit(
      {
        actorId,
        actorType: 'user',
        action: 'cycle.imported',
        entityType: 'cycle',
        entityId: cycle.data,
        detail: { rows: ids.length, filename: req.file?.originalname ?? null },
      },
      client,
    );

    return ids;
  });

  const result = await rescoreCycle(cycle.data, actorId);

  res.status(201).json({
    imported: created.length,
    cycle: cycle.data,
    households: result.reconcile.componentCount,
    scored: result.scored.scored.length,
    flagsWritten: result.scored.flagsWritten,
  });
});

/* ------------------------------------------------------------------ rules */

adminRouter.get('/rules', requireStaff(), (_req, res) => {
  const rules = loadRulesConfig();
  res.json({
    version: rules.version,
    editable: false,
    note: `Weights are versioned in config/rules.${rules.version}.json and stamped onto every flag. Changing them is a new version file, so historical scores stay reproducible.`,
    config: rules,
  });
});
