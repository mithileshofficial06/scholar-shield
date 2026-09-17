/**
 * The reviewer risk queue.
 *
 * Ordered by score descending, then oldest first — a high score moves an
 * application up the queue and does nothing else.
 *
 * FILTERS ARE PART OF THE PRODUCT, NOT A CONVENIENCE
 * --------------------------------------------------
 * A committee works a queue in passes: the high-severity cases first, then one
 * district, then everything a particular rule fired on. Without filters the
 * reviewer scrolls, and scrolling past an application is how it gets skipped.
 *
 * Every filter is applied in SQL against an indexed column; none of them are
 * post-filtered in JavaScript, so the returned `total` is the true count for
 * the filter rather than the length of one page.
 */

import { Router } from 'express';
import { z } from 'zod';

import { requireStaff } from '../auth/middleware.js';
import { query } from '../db.js';
import { toQueueItem } from '../serializers.js';

export const queueRouter = Router();

const querySchema = z.object({
  cycle: z.string().regex(/^\d{4}$/).optional(),
  /** `decided` covers approved and rejected; the default is the working queue. */
  status: z.enum(['awaiting', 'decided', 'all']).default('awaiting'),
  severity: z.enum(['high', 'medium', 'low', 'any']).default('any'),
  ruleId: z.string().max(60).optional(),
  district: z.string().max(80).optional(),
  q: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

type QueueQuery = z.infer<typeof querySchema>;

interface QueueRow {
  id: string;
  applicant_name: string;
  district: string;
  cycle: string;
  status: Parameters<typeof toQueueItem>[0]['status'];
  risk_score: string;
  top_flag_reason: string | null;
  flag_count: string;
  high_severity_count: string;
  submitted_at: Date;
  total: string;
}

/**
 * One statement for the page and its total.
 *
 * `count(*) OVER ()` rides along with the same filters, so the count can never
 * describe a different set than the rows do — which is exactly what happens when
 * a second hand-maintained count query drifts from the first.
 */
function buildQuery(filters: QueueQuery): { text: string; values: unknown[] } {
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (value: unknown) => `$${values.push(value)}`;

  switch (filters.status) {
    case 'awaiting':
      where.push(`a.status IN ('ready_for_review', 'escalated')`);
      break;
    case 'decided':
      where.push(`a.status IN ('approved', 'rejected')`);
      break;
    case 'all':
      break;
  }

  if (filters.cycle) where.push(`a.cycle = ${add(filters.cycle)}`);
  if (filters.district) where.push(`lower(a.district) = lower(${add(filters.district)})`);

  if (filters.q) {
    // Name or certificate number — the two things a reviewer has in hand when
    // someone telephones about an application.
    const term = `%${filters.q.trim()}%`;
    where.push(`(a.applicant_name ILIKE ${add(term)} OR a.guardian_name ILIKE ${add(term)}
                 OR a.certificate_id ILIKE ${add(term)})`);
  }

  if (filters.severity !== 'any') {
    where.push(
      `EXISTS (SELECT 1 FROM risk_flags f WHERE f.application_id = a.id AND f.severity = ${add(filters.severity)})`,
    );
  }

  if (filters.ruleId) {
    where.push(
      `EXISTS (SELECT 1 FROM risk_flags f WHERE f.application_id = a.id AND f.rule_id = ${add(filters.ruleId)})`,
    );
  }

  const text = `
    SELECT a.id, a.applicant_name, a.district, a.cycle, a.status,
           a.risk_score, a.submitted_at,
           count(f.id)::text AS flag_count,
           count(f.id) FILTER (WHERE f.severity = 'high')::text AS high_severity_count,
           (SELECT reason FROM risk_flags
             WHERE application_id = a.id
             ORDER BY weight DESC LIMIT 1) AS top_flag_reason,
           count(*) OVER ()::text AS total
      FROM applications a
      LEFT JOIN risk_flags f ON f.application_id = a.id
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     GROUP BY a.id
     ORDER BY a.risk_score DESC, a.submitted_at ASC
     LIMIT ${add(filters.limit)} OFFSET ${add(filters.offset)}`;

  return { text, values };
}

queueRouter.get('/', requireStaff(), async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'Bad query parameters.' });
    return;
  }

  const { text, values } = buildQuery(parsed.data);
  const { rows } = await query<QueueRow>(text, values as never[]);

  res.json({
    items: rows.map((row) => toQueueItem(row)),
    total: Number(rows[0]?.total ?? 0),
    limit: parsed.data.limit,
    offset: parsed.data.offset,
  });
});

/** The rules that have actually fired, for the filter control. */
queueRouter.get('/rules', requireStaff(), async (_req, res) => {
  const { rows } = await query<{ rule_id: string; count: string }>(
    `SELECT rule_id, count(*)::text AS count FROM risk_flags GROUP BY rule_id ORDER BY count(*) DESC`,
  );
  res.json({ items: rows.map((row) => ({ ruleId: row.rule_id, count: Number(row.count) })) });
});

/** Districts present in the data, for the filter control. */
queueRouter.get('/districts', requireStaff(), async (_req, res) => {
  const { rows } = await query<{ district: string }>(
    `SELECT DISTINCT district FROM applications ORDER BY district`,
  );
  res.json({ items: rows.map((row) => row.district) });
});

/* ----------------------------------------------------------------- export */

/** RFC 4180: double the quotes, wrap anything containing a delimiter. */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The queue as a CSV, for a committee's own records.
 *
 * Carries the decision and its reason where one exists, because the point of
 * the export is the minutes of a meeting, not a leaderboard of scores.
 */
queueRouter.get('/export.csv', requireStaff(), async (req, res) => {
  const parsed = querySchema.safeParse({ ...req.query, limit: 200, offset: 0 });
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'Bad query parameters.' });
    return;
  }

  const { rows } = await query<{
    applicant_name: string;
    guardian_name: string;
    district: string;
    cycle: string;
    status: string;
    risk_score: string;
    flag_count: string;
    high_severity_count: string;
    rules: string | null;
    submitted_at: Date;
    decision: string | null;
    decision_reason: string | null;
    decided_by: string | null;
    decided_at: Date | null;
  }>(
    `SELECT a.applicant_name, a.guardian_name, a.district, a.cycle, a.status,
            a.risk_score, a.submitted_at,
            count(f.id)::text AS flag_count,
            count(f.id) FILTER (WHERE f.severity = 'high')::text AS high_severity_count,
            string_agg(DISTINCT f.rule_id, ' | ') AS rules,
            r.decision, r.reason AS decision_reason, u.email AS decided_by, r.created_at AS decided_at
       FROM applications a
       LEFT JOIN risk_flags f ON f.application_id = a.id
       LEFT JOIN LATERAL (
         SELECT decision, reason, reviewer_id, created_at
           FROM reviews WHERE application_id = a.id
          ORDER BY created_at DESC LIMIT 1
       ) r ON true
       LEFT JOIN users u ON u.id = r.reviewer_id
      WHERE ($1::text IS NULL OR a.cycle = $1)
      GROUP BY a.id, r.decision, r.reason, u.email, r.created_at
      ORDER BY a.risk_score DESC, a.submitted_at ASC`,
    [parsed.data.cycle ?? null],
  );

  const header = [
    'applicant_name', 'guardian_name', 'district', 'cycle', 'status', 'risk_score',
    'flag_count', 'high_severity_flags', 'rules_fired', 'submitted_at',
    'decision', 'decision_reason', 'decided_by', 'decided_at',
  ];

  const body = rows.map((row) =>
    [
      row.applicant_name, row.guardian_name, row.district, row.cycle, row.status,
      row.risk_score, row.flag_count, row.high_severity_count, row.rules ?? '',
      new Date(row.submitted_at).toISOString(),
      row.decision ?? '', row.decision_reason ?? '', row.decided_by ?? '',
      row.decided_at ? new Date(row.decided_at).toISOString() : '',
    ].map(csvCell).join(','),
  );

  const filename = `scholarshield-queue-${parsed.data.cycle ?? 'all'}-${new Date().toISOString().slice(0, 10)}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // A leading BOM so Excel opens ₹ and Tamil names correctly instead of mojibake.
  res.send(`﻿${[header.join(','), ...body].join('\r\n')}\r\n`);
});
