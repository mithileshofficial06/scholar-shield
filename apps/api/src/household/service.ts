/**
 * Household resolution and scoring, per cycle.
 *
 * Extracted from the pipeline stages because three callers need it and only one
 * of them has a document: the pipeline (a new upload), a CSV import (many
 * applications and no documents at all), and a reviewer rejecting a merge the
 * resolver proposed. Keying this on a document id would have forced the other
 * two to invent one.
 *
 * Rules are evaluated over the whole cycle in one pass — guardian contradictions
 * and address clusters compare applications ACROSS households, so scoring a
 * component in isolation cannot see them.
 */

import type { RuleFinding } from '../household/rules.js';

import { recordAudit } from '../audit.js';
import { config } from '../config.js';
import { query, withTransaction, type QueryParam } from '../db.js';
import {
  componentFor,
  detectComponents,
  edgeKey,
  type HouseholdComponent,
} from './components.js';
import { loadRulesConfig } from './config.js';
import type { ApplicationChecklist } from '@scholarshield/shared';

import { certificateIncomeFrom, type CertificateEvidence } from './certificate.js';
import { buildChecklist, type ChecklistFlag, type StageRun } from './checklist.js';
import { normalizeIdentity } from './normalize.js';
import { linkedPairs, type MatchField, type ResolutionInput } from './resolve.js';
import { evaluateRules, type ScorableApplication } from './rules.js';

// ------------------------------------------------- 4. Household reconcile

interface ApplicationRow {
  id: string;
  cycle: string;
  applicant_name: string;
  guardian_name: string;
  guardian_phone: string | null;
  address_line: string;
  district: string;
  declared_annual_income: string;
  declared_family_size: number;
  certificate_id: string | null;
  issuing_office: string | null;
  certificate_issue_date: string | null;
  normalized_applicant_name: string | null;
  normalized_guardian_name: string | null;
  normalized_address: string | null;
  normalized_phone: string | null;
  pincode: string | null;
  /** The latest document that OCR has read, and what the pipeline learned from it. */
  certificate_fields: Record<string, { value: string | null; confidence: number } | undefined> | null;
  ocr_report: { incomeWordsMismatch?: boolean | null } | null;
  tamper_score: string | null;
  forensics: { elaApplied?: boolean; encoding?: { softwareTags?: string[] } } | null;
  verification_status: ScorableApplication['verificationStatus'];
}

async function applicationsInCycle(cycle: string): Promise<ApplicationRow[]> {
  return selectApplications('a.cycle = $1', [cycle]);
}

/**
 * The one query that turns applications into what the rules read. Scoring and
 * the reviewer's checklist both go through it, so the checklist sees exactly
 * the inputs the score was computed from.
 */
async function selectApplications(where: string, params: QueryParam[]): Promise<ApplicationRow[]> {
  // Latest read document only: a re-upload replaces what the applicant is
  // standing behind, and an older certificate is not a claim they still make.
  const { rows } = await query<ApplicationRow>(
    `SELECT a.id, a.cycle, a.applicant_name, a.guardian_name, a.guardian_phone, a.address_line,
            a.district, a.pincode, a.declared_annual_income, a.declared_family_size, a.certificate_id,
            a.issuing_office, a.certificate_issue_date,
            a.normalized_applicant_name, a.normalized_guardian_name,
            a.normalized_address, a.normalized_phone,
            d.extracted_fields AS certificate_fields, d.ocr_report, d.tamper_score, d.forensics,
            v.status AS verification_status
       FROM applications a
       LEFT JOIN LATERAL (
         SELECT extracted_fields, ocr_report, tamper_score, forensics
           FROM documents
          WHERE application_id = a.id AND extracted_fields IS NOT NULL AND purged_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
       ) d ON true
       LEFT JOIN LATERAL (
         SELECT status FROM verification_results
          WHERE application_id = a.id
          ORDER BY created_at DESC
          LIMIT 1
       ) v ON true
      WHERE ${where}`,
    params,
  );
  return rows;
}

/** Null until OCR has read a document; forensics may still be pending then. */
function toCertificateEvidence(row: ApplicationRow): CertificateEvidence | null {
  if (!row.certificate_fields) return null;
  return {
    fields: row.certificate_fields,
    incomeWordsMismatch: row.ocr_report?.incomeWordsMismatch ?? null,
    tamperScore: row.tamper_score === null ? null : Number(row.tamper_score),
    elaApplied: row.forensics ? (row.forensics.elaApplied ?? true) : null,
    softwareTags: row.forensics?.encoding?.softwareTags ?? [],
  };
}

/** Fill in normalized columns for any application that lacks them. */
async function ensureNormalized(rows: ApplicationRow[]): Promise<ApplicationRow[]> {
  const pending = rows.filter((row) => row.normalized_guardian_name === null);

  for (const row of pending) {
    const normalized = normalizeIdentity({
      applicantName: row.applicant_name,
      guardianName: row.guardian_name,
      addressLine: row.address_line,
      district: row.district,
      guardianPhone: row.guardian_phone,
    });

    await query(
      `UPDATE applications
          SET normalized_applicant_name = $2,
              normalized_guardian_name  = $3,
              normalized_address        = $4,
              normalized_phone          = $5
        WHERE id = $1`,
      [
        row.id,
        normalized.normalizedApplicantName,
        normalized.normalizedGuardianName,
        normalized.normalizedAddress,
        normalized.normalizedPhone,
      ],
    );

    row.normalized_applicant_name = normalized.normalizedApplicantName;
    row.normalized_guardian_name = normalized.normalizedGuardianName;
    row.normalized_address = normalized.normalizedAddress;
    row.normalized_phone = normalized.normalizedPhone;
  }

  return rows;
}

/**
 * Raw fields, not the normalized columns.
 *
 * `resolve.ts` normalizes internally, and feeding it already-normalized values
 * would run the pipeline twice — quietly changing what "similar" means, since
 * normalization is not idempotent across every field. The normalized columns
 * exist for the `pg_trgm` indexes that narrow candidates in SQL, which is a
 * different job.
 */
function toResolutionInput(row: ApplicationRow): ResolutionInput {
  return {
    id: row.id,
    applicantName: row.applicant_name,
    guardianName: row.guardian_name,
    addressLine: row.address_line,
    district: row.district,
    guardianPhone: row.guardian_phone,
  };
}

function toScorable(row: ApplicationRow): ScorableApplication {
  const certificate = toCertificateEvidence(row);
  return {
    id: row.id,
    cycle: row.cycle,
    applicantName: row.applicant_name,
    declaredAnnualIncome: Number(row.declared_annual_income),
    declaredFamilySize: row.declared_family_size,
    normalizedGuardianName: row.normalized_guardian_name ?? '',
    normalizedAddress: row.normalized_address ?? '',
    normalizedGuardianPhone: row.normalized_phone,
    issuingOffice: row.issuing_office,
    certificateIssueDate: row.certificate_issue_date,
    certificateId: row.certificate_id,
    guardianName: row.guardian_name,
    district: row.district,
    pincode: row.pincode,
    certificate,
    certificateIncome: certificateIncomeFrom(certificate),
    verificationStatus: row.verification_status,
  };
}

export interface ReconcileResult {
  cycle: string;
  applicationCount: number;
  edgeCount: number;
  componentCount: number;
  /** Applications whose score must be recomputed — the whole affected household. */
  rescore: string[];
}

/**
 * Resolve households across the cycle and persist edges and membership.
 *
 * Reviewer-rejected edges are preserved: a merge a human has already declined
 * must not reappear the next time the resolver runs, or the rejection is
 * cosmetic.
 */
export async function reconcileCycle(
  cycle: string,
  focusApplicationId: string | null = null,
): Promise<ReconcileResult> {
  const rows = await ensureNormalized(await applicationsInCycle(cycle));

  const pairs = linkedPairs(rows.map(toResolutionInput));
  const rejectedEdgeKeys = await loadRejectedEdgeKeys();

  await withTransaction(async (client) => {
    for (const pair of pairs) {
      for (const edge of pair.edges) {
        // A merge a reviewer already declined must not reappear, or the
        // rejection is cosmetic. The WHERE on the conflict branch also stops an
        // update from resurrecting one.
        if (rejectedEdgeKeys.has(edgeKey(edge))) continue;

        await client.query(
          `INSERT INTO household_edges
             (application_a_id, application_b_id, match_field, similarity, weight)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (application_a_id, application_b_id, match_field) DO UPDATE
             SET similarity = EXCLUDED.similarity, weight = EXCLUDED.weight
           WHERE household_edges.rejected_at IS NULL`,
          [
            edge.applicationAId,
            edge.applicationBId,
            edge.matchField,
            edge.similarity,
            edge.weight,
          ],
        );
      }
    }
  });

  const components = detectComponents(
    rows.map((row) => row.id),
    pairs,
    { rejectedEdgeKeys },
  );

  await persistComponents(cycle, components);

  // With a focus application: everything in the component it landed in — see
  // the fan-out note in the pipeline stages module. Without one (a CSV import,
  // or a reviewer rejecting an edge) every application in the cycle is affected,
  // because membership may have changed anywhere in it.
  const rescore = focusApplicationId
    ? (componentFor(components, focusApplicationId)?.applicationIds ?? [focusApplicationId])
    : rows.map((row) => row.id);

  return {
    cycle,
    applicationCount: rows.length,
    edgeCount: components.reduce((total, c) => total + c.edges.length, 0),
    componentCount: components.length,
    rescore,
  };
}

/** Edges a reviewer has rejected, keyed the way `components.ts` expects. */
async function loadRejectedEdgeKeys(): Promise<Set<string>> {
  const { rows } = await query<{
    application_a_id: string;
    application_b_id: string;
    match_field: MatchField;
  }>(
    `SELECT application_a_id, application_b_id, match_field
       FROM household_edges
      WHERE rejected_at IS NOT NULL`,
  );

  return new Set(
    rows.map((row) =>
      edgeKey({
        applicationAId: row.application_a_id,
        applicationBId: row.application_b_id,
        matchField: row.match_field,
        similarity: 0,
        weight: 0,
      }),
    ),
  );
}

async function persistComponents(
  cycle: string,
  components: HouseholdComponent[],
): Promise<void> {
  await withTransaction(async (client) => {
    // Two workers reconciling one cycle at once would each rebuild membership
    // from their own snapshot and interleave. Serialize per cycle.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [cycle]);

    // Membership is rebuilt from scratch on every run. Without clearing it, an
    // application whose household was split — a reviewer rejecting the only
    // edge — would keep pointing at the household it left, and every run
    // would leave the previous run's household rows behind as orphans.
    await client.query(`UPDATE applications SET household_id = NULL WHERE cycle = $1`, [cycle]);

    for (const component of components) {
      // A single-member component is not a household; leaving it unlinked keeps
      // `households` meaning "applications the resolver actually joined".
      if (component.applicationIds.length < 2) continue;

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO households (cycle, member_count)
         VALUES ($1, $2)
         RETURNING id`,
        [cycle, component.applicationIds.length],
      );
      const householdId = rows[0]!.id;

      await client.query(
        `UPDATE applications SET household_id = $1 WHERE id = ANY($2::uuid[])`,
        [householdId, component.applicationIds],
      );
    }

    await client.query(
      `DELETE FROM households h
        WHERE h.cycle = $1
          AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.household_id = h.id)`,
      [cycle],
    );
  });
}

// ------------------------------------------------------------ 5. Scoring

export interface ScoreResult {
  scored: string[];
  flagsWritten: number;
}

/**
 * Evaluate the contradiction rules and persist flags.
 *
 * Every flag carries its rule id and the config version that produced it, so a
 * historical score stays reproducible against the config it was computed under.
 * The `ON CONFLICT DO NOTHING` on that triple is what makes re-running the stage
 * safe under at-least-once delivery.
 */
export async function scoreApplications(
  cycle: string,
  applicationIds: string[],
  audit: { actorId: string | null; actorType: 'user' | 'system'; entityType: string; entityId: string },
): Promise<ScoreResult> {
  const rulesConfig = loadRulesConfig();
  const rows = await ensureNormalized(await applicationsInCycle(cycle));

  const inputs = rows.map(toResolutionInput);
  const components = detectComponents(
    rows.map((row) => row.id),
    linkedPairs(inputs),
    { rejectedEdgeKeys: await loadRejectedEdgeKeys() },
  );

  // Rules are evaluated over the whole cycle in one pass: several of them —
  // guardian contradictions and address clusters — compare applications ACROSS
  // households, so scoring one component in isolation cannot see them.
  const evaluation = evaluateRules(
    rows.map(toScorable),
    components,
    rulesConfig,
    config.CYCLE_DEADLINE,
  );

  const findingsByApplication = new Map<string, typeof evaluation.findings>();
  for (const finding of evaluation.findings) {
    const bucket = findingsByApplication.get(finding.applicationId) ?? [];
    bucket.push(finding);
    findingsByApplication.set(finding.applicationId, bucket);
  }

  let flagsWritten = 0;
  const scored: string[] = [];
  const target = new Set(applicationIds);

  for (const applicationId of target) {
    const findings = findingsByApplication.get(applicationId) ?? [];

    await withTransaction(async (client) => {
      // A flag is a claim about the application as it stands, not a log entry.
      // When a reviewer rejects a merge, the contradiction that merge implied
      // stops being true, and leaving the row behind would show a reviewer a
      // finding the engine no longer makes — while inflating the queue's flag
      // count for good. The audit log, which is the record of what happened,
      // is untouched by this.
      // Scoped to the active config version as well as the rule set: after a
      // version bump the same rule would otherwise keep a v1 row beside its new
      // v2 row and be counted twice. Which config produced a live flag is still
      // stamped on it; reproducing an older score is the job of the versioned
      // config file and the audit log, not of stale rows.
      await client.query(
        `DELETE FROM risk_flags
          WHERE application_id = $1
            AND NOT (rule_config_version = $3 AND rule_id = ANY($2::text[]))`,
        [applicationId, findings.map((finding) => finding.ruleId), rulesConfig.version],
      );

      for (const finding of findings) {
        const { rowCount } = await client.query(
          `INSERT INTO risk_flags
             (application_id, rule_id, rule_config_version, severity, weight, reason, evidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (application_id, rule_id, rule_config_version) DO UPDATE
             SET severity = EXCLUDED.severity,
                 weight   = EXCLUDED.weight,
                 reason   = EXCLUDED.reason,
                 evidence = EXCLUDED.evidence`,
          [
            applicationId,
            finding.ruleId,
            rulesConfig.version,
            finding.severity,
            finding.weight,
            finding.reason,
            JSON.stringify(finding.evidence),
          ],
        );
        flagsWritten += rowCount ?? 0;
      }

      // The score comes from the evaluation, not from re-summing weights here:
      // the corroboration pass can suppress a finding, and a second summation
      // would silently disagree with the flags that were actually written.
      await client.query(
        `UPDATE applications
            SET risk_score = $2, scored_at = now(),
                status = CASE WHEN status IN ('submitted', 'processing')
                              THEN 'ready_for_review' ELSE status END
          WHERE id = $1`,
        [applicationId, evaluation.scores.get(applicationId) ?? 0],
      );
    });

    scored.push(applicationId);
  }

  await recordAudit({
    actorId: audit.actorId,
    actorType: audit.actorType,
    action: 'pipeline.scored',
    entityType: audit.entityType,
    entityId: audit.entityId,
    detail: { cycle, scored: scored.length, flagsWritten, configVersion: rulesConfig.version },
  });

  return { scored, flagsWritten };
}

// ------------------------------------------------------- reviewer checklist

/** Every check on one application, passed or not. Null for an unknown id. */
export async function applicationChecklist(applicationId: string): Promise<ApplicationChecklist | null> {
  const rows = await ensureNormalized(await selectApplications('a.id = $1', [applicationId]));
  const row = rows[0];
  if (!row) return null;

  const [documents, flags, meta] = await Promise.all([
    query<{ id: string; ocr_report: { pageConfidence?: number } | null }>(
      `SELECT id, ocr_report FROM documents WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [applicationId],
    ),
    query<{ rule_id: string; rule_config_version: string; severity: ChecklistFlag['severity']; reason: string }>(
      `SELECT rule_id, rule_config_version, severity, reason FROM risk_flags WHERE application_id = $1`,
      [applicationId],
    ),
    query<{ scored_at: Date | null; member_count: number | null; manual_check_url: string | null }>(
      `SELECT a.scored_at, h.member_count,
              (SELECT manual_check_url FROM verification_results v
                WHERE v.application_id = a.id ORDER BY created_at DESC LIMIT 1) AS manual_check_url
         FROM applications a LEFT JOIN households h ON h.id = a.household_id
        WHERE a.id = $1`,
      [applicationId],
    ),
  ]);

  const document = documents.rows[0];
  const stages = document
    ? await query<{ stage: string; status: StageRun['status']; last_error: string | null }>(
        `SELECT stage, status, last_error FROM pipeline_stage_runs WHERE document_id = $1`,
        [document.id],
      )
    : { rows: [] };

  return buildChecklist({
    application: toScorable(row),
    hasDocument: Boolean(document),
    pageConfidence: document?.ocr_report?.pageConfidence ?? null,
    stages: stages.rows.map((s) => ({ stage: s.stage, status: s.status, lastError: s.last_error })),
    flags: flags.rows.map((f) => ({
      ruleId: f.rule_id,
      ruleConfigVersion: f.rule_config_version,
      severity: f.severity,
      reason: f.reason,
    })),
    householdSize: meta.rows[0]?.member_count ?? 1,
    scored: Boolean(meta.rows[0]?.scored_at),
    manualCheckUrl: meta.rows[0]?.manual_check_url ?? null,
    config: loadRulesConfig(),
  });
}
