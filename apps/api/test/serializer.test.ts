import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_APPLICANT_FIELDS,
  toApplicantView,
  type ApplicationRow,
} from '../src/serializers.js';

/**
 * PROJECT_REPORT.md §11 — score and flag data must never reach an applicant.
 *
 * The interesting case is the second test: a database row carrying every internal
 * field is passed in, and the serialized output must still be clean. That is what
 * catches a future `return { ...row, stage }` refactor.
 */
describe('applicant serializer', () => {
  const baseRow: ApplicationRow = {
    id: '11111111-1111-1111-1111-111111111111',
    cycle: '2026',
    status: 'ready_for_review',
    submitted_at: '2026-06-20T09:00:00.000Z',
  };

  it('exposes only the applicant-safe fields', () => {
    const view = toApplicantView(baseRow, 2);

    expect(Object.keys(view).sort()).toEqual(
      ['cycle', 'documentCount', 'id', 'stage', 'submittedAt'].sort(),
    );
    expect(view.stage).toBe('under_review');
    expect(view.documentCount).toBe(2);
  });

  it('drops internal fields even when the row carries them', () => {
    const pollutedRow = {
      ...baseRow,
      risk_score: 87.5,
      household_id: 'abc',
      tamper_score: 0.91,
      normalizedGuardianName: 'raman subramaniam',
      flags: [{ ruleId: 'SIBLING_INCOME_CONTRADICTION' }],
      forensics: { ela: 'high' },
    } as unknown as ApplicationRow;

    const serialized = JSON.stringify(toApplicantView(pollutedRow, 1));

    for (const field of FORBIDDEN_APPLICANT_FIELDS) {
      expect(serialized).not.toContain(field);
    }
    expect(serialized).not.toContain('87.5');
    expect(serialized).not.toContain('SIBLING_INCOME_CONTRADICTION');
  });

  it('collapses internal statuses into a coarse applicant-facing stage', () => {
    const stageFor = (status: ApplicationRow['status']) =>
      toApplicantView({ ...baseRow, status }, 0).stage;

    expect(stageFor('submitted')).toBe('submitted');
    expect(stageFor('processing')).toBe('submitted');
    expect(stageFor('ready_for_review')).toBe('under_review');
    expect(stageFor('approved')).toBe('decided');
    expect(stageFor('rejected')).toBe('decided');
    // An applicant must not be able to tell approval from rejection from escalation
    // by the stage field alone — the decision is communicated deliberately, not leaked.
    expect(stageFor('escalated')).toBe('decided');
    // Trash is the one a reviewer would least like leaked: an applicant told
    // their submission was binned learns the committee's private judgement of
    // it. It collapses into the same word as every other outcome.
    expect(stageFor('trashed')).toBe('decided');
  });
});
