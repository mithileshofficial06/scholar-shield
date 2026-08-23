import { Router } from 'express';
import { query } from '../db.js';
import { requireApplicant } from '../auth/middleware.js';
import { toApplicantView, type ApplicationRow } from '../serializers.js';

export const applicationsRouter = Router();

/**
 * Applicant-facing: only ever the caller's own applications, and only through
 * toApplicantView. Week 2 adds submission; this establishes the scoping first so
 * no later handler is written against an unscoped query by habit.
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
