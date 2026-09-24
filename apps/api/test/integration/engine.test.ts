/**
 * The engine's population and fan-out, against a real database.
 *
 * Each case pins a defect that existed: a cross-household finding that never
 * reached the application already in the queue; two workers reconciling one
 * cycle and dropping a household member; and a junk or unconfirmed
 * application raising a real applicant's score.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { query } from '../../src/db.js';
import { rescoreCycle } from '../../src/routes/applications.js';
import { processDocument } from '../../src/pipeline/worker.js';
import { closePool, requireDatabase, resetData, seedApplication, stubContext } from './helpers.js';

beforeAll(requireDatabase);
beforeEach(resetData);
afterAll(closePool);

const rules = async (applicationId: string): Promise<string[]> => {
  const { rows } = await query<{ rule_id: string }>(
    `SELECT rule_id FROM risk_flags WHERE application_id = $1 ORDER BY rule_id`,
    [applicationId],
  );
  return rows.map((r) => r.rule_id);
};

const application = async (id: string) => {
  const { rows } = await query<{ status: string; risk_score: string; household_id: string | null }>(
    `SELECT status, risk_score, household_id FROM applications WHERE id = $1`,
    [id],
  );
  return rows[0]!;
};

const run = (seeded: { documentId: string; applicationId: string }) =>
  processDocument({ documentId: seeded.documentId, applicationId: seeded.applicationId }, stubContext().ctx);

const household = {
  guardianName: 'Palanisamy Kandasamy',
  addressLine: '12 Thiruvalluvar Street, Gandhipuram',
  guardianPhone: '9042118876',
};

describe('findings that reach across households', () => {
  it('flag the application already in the queue, not only the new upload', async () => {
    // Two unrelated families — nothing in common but a certificate number, so
    // they never resolve into one household and the new upload's fan-out used
    // to stop at its own.
    const first = await seedApplication({ certificateId: 'TN-CBE-2026-555001' });
    await run(first);
    expect(await rules(first.applicationId)).not.toContain('DUPLICATE_CERTIFICATE_ID');

    const second = await seedApplication({ certificateId: 'TN-CBE-2026-555001' });
    await run(second);

    expect((await application(first.applicationId)).household_id).toBeNull();
    expect(await rules(second.applicationId)).toContain('DUPLICATE_CERTIFICATE_ID');
    expect(await rules(first.applicationId)).toContain('DUPLICATE_CERTIFICATE_ID');
    expect(Number((await application(first.applicationId)).risk_score)).toBeGreaterThan(0);
  });
});

describe('two workers reconciling one cycle', () => {
  it('leave every member in the household', async () => {
    const members = await Promise.all([
      seedApplication({ ...household, declaredAnnualIncome: 90_000 }),
      seedApplication({ ...household, declaredAnnualIncome: 91_000 }),
      seedApplication({ ...household, declaredAnnualIncome: 92_000 }),
    ]);

    await Promise.all(members.map(run));

    const households = await Promise.all(members.map((m) => application(m.applicationId)));
    expect(households[0]!.household_id).not.toBeNull();
    expect(new Set(households.map((h) => h.household_id)).size).toBe(1);

    // Three reconciliations saw the rows in whatever order Postgres returned
    // them; each match is still stored once, not once per direction.
    await rescoreCycle('2026', null);
    const { rows } = await query<{ total: string; pairs: string }>(
      `SELECT count(*)::text AS total,
              count(DISTINCT (least(application_a_id, application_b_id),
                              greatest(application_a_id, application_b_id), match_field))::text AS pairs
         FROM household_edges`,
    );
    expect(Number(rows[0]!.total)).toBeGreaterThan(0);
    expect(rows[0]!.total).toBe(rows[0]!.pairs);
  });
});

describe('who counts as a member of the population', () => {
  it('ignores an unconfirmed public submission until its email is confirmed', async () => {
    const real = await seedApplication({ ...household, declaredAnnualIncome: 88_000 });
    await run(real);

    // A stranger files a "sibling" under an address they do not control.
    const planted = await seedApplication({ ...household, declaredAnnualIncome: 240_000 });
    await query(`UPDATE applicants SET email_confirmed_at = NULL WHERE id = $1`, [planted.applicantId]);
    await run(planted);

    expect(await rules(real.applicationId)).not.toContain('SIBLING_INCOME_CONTRADICTION');
    expect(Number((await application(real.applicationId)).risk_score)).toBe(0);
    // Not promoted into the reviewer queue with a score no rule computed.
    expect((await application(planted.applicationId)).status).toBe('processing');

    // Once the owner of the address confirms it, it is a real claim and counts.
    await query(`UPDATE applicants SET email_confirmed_at = now() WHERE id = $1`, [planted.applicantId]);
    await rescoreCycle('2026', null);

    expect(await rules(real.applicationId)).toContain('SIBLING_INCOME_CONTRADICTION');
    expect((await application(planted.applicationId)).status).toBe('ready_for_review');
  });

  it('withdraws a contradiction caused by an application a reviewer trashed', async () => {
    const real = await seedApplication({ ...household, declaredAnnualIncome: 88_000 });
    const junk = await seedApplication({ ...household, declaredAnnualIncome: 240_000 });
    await run(real);
    await run(junk);
    expect(await rules(real.applicationId)).toContain('SIBLING_INCOME_CONTRADICTION');

    await query(`UPDATE applications SET status = 'trashed' WHERE id = $1`, [junk.applicationId]);
    await rescoreCycle('2026', null);

    expect(await rules(real.applicationId)).not.toContain('SIBLING_INCOME_CONTRADICTION');
    expect((await application(real.applicationId)).household_id).toBeNull();
  });
});
