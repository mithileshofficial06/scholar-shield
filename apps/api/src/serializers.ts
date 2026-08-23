import type {
  ApplicantApplicationView,
  ApplicationDetail,
  ApplicationStatus,
  QueueItem,
} from '@scholarshield/shared';

/**
 * The applicant/staff serialization boundary (PROJECT_REPORT.md §11).
 *
 * Risk scores, flags, households, and forensics must never reach an applicant.
 * Enforcing that in the UI is not enough — a forgotten `res.json(row)` leaks the
 * whole row. Every applicant-facing response goes through toApplicantView, which
 * constructs its output field by field rather than deleting keys from a record.
 *
 * `test/serializer.test.ts` asserts the output contains no forbidden key.
 */

/** Field names that must never appear in an applicant-facing payload. */
export const FORBIDDEN_APPLICANT_FIELDS = [
  'riskScore',
  'risk_score',
  'flags',
  'riskFlags',
  'risk_flags',
  'household',
  'householdId',
  'household_id',
  'tamperScore',
  'tamper_score',
  'forensics',
  'elaHeatmapKey',
  'ela_heatmap_key',
  'evidence',
  'scoredAt',
  'scored_at',
  'normalizedApplicantName',
  'normalizedGuardianName',
  'normalizedAddress',
  'normalizedPhone',
] as const;

/** Applicants see a coarse stage, never the internal status. */
function toStage(status: ApplicationStatus): ApplicantApplicationView['stage'] {
  switch (status) {
    case 'submitted':
    case 'processing':
      return 'submitted';
    case 'ready_for_review':
      return 'under_review';
    case 'approved':
    case 'escalated':
    case 'rejected':
      return 'decided';
  }
}

export interface ApplicationRow {
  id: string;
  cycle: string;
  status: ApplicationStatus;
  submitted_at: Date | string;
}

export function toApplicantView(
  row: ApplicationRow,
  documentCount: number,
): ApplicantApplicationView {
  // Built by explicit construction. Never spread a database row in here.
  return {
    id: row.id,
    cycle: row.cycle,
    stage: toStage(row.status),
    submittedAt: new Date(row.submitted_at).toISOString(),
    documentCount,
  };
}

export function toQueueItem(row: {
  id: string;
  applicant_name: string;
  district: string;
  cycle: string;
  status: ApplicationStatus;
  risk_score: string | number;
  top_flag_reason: string | null;
  flag_count: string | number;
  high_severity_count: string | number;
  submitted_at: Date | string;
}): QueueItem {
  return {
    id: row.id,
    applicantName: row.applicant_name,
    district: row.district,
    cycle: row.cycle,
    status: row.status,
    riskScore: Number(row.risk_score),
    topFlagReason: row.top_flag_reason,
    flagCount: Number(row.flag_count),
    highSeverityCount: Number(row.high_severity_count),
    submittedAt: new Date(row.submitted_at).toISOString(),
  };
}

export type { ApplicationDetail };
