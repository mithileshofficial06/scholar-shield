import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { requireStaff } from '../auth/middleware.js';
import { toQueueItem } from '../serializers.js';

export const queueRouter = Router();

const querySchema = z.object({
  cycle: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * The reviewer risk queue. Ordered by score descending, then oldest first — a
 * high score moves an application up the queue and does nothing else.
 */
queueRouter.get('/', requireStaff(), async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', message: 'Bad query parameters.' });
    return;
  }
  const { cycle, limit, offset } = parsed.data;

  const { rows } = await query(
    `SELECT a.id, a.applicant_name, a.district, a.cycle, a.status,
            a.risk_score, a.submitted_at,
            count(f.id)::text AS flag_count,
            count(f.id) FILTER (WHERE f.severity = 'high')::text AS high_severity_count,
            (SELECT reason FROM risk_flags
              WHERE application_id = a.id
              ORDER BY weight DESC LIMIT 1) AS top_flag_reason
       FROM applications a
       LEFT JOIN risk_flags f ON f.application_id = a.id
      WHERE a.status IN ('ready_for_review', 'escalated')
        AND ($1::text IS NULL OR a.cycle = $1)
      GROUP BY a.id
      ORDER BY a.risk_score DESC, a.submitted_at ASC
      LIMIT $2 OFFSET $3`,
    [cycle ?? null, limit, offset],
  );

  res.json({
    items: rows.map((row) => toQueueItem(row as never)),
    limit,
    offset,
  });
});
