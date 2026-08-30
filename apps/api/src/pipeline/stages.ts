/**
 * The five pipeline stages (PROJECT_REPORT.md §10).
 *
 * Each handler does one thing and persists its own result. None of them decides
 * anything: the last stage writes rows to `risk_flags` and a number to
 * `applications.risk_score`, and that number changes queue position and nothing
 * else. There is no branch anywhere in this file that approves or rejects.
 *
 * ORDERING AND WHY IT IS NOT NEGOTIABLE
 * -------------------------------------
 *   ocr_extract  -> forensics_analyze -> verification_check
 *                -> household_reconcile -> risk_score
 *
 * Reconciliation must run after extraction because a certificate's *printed*
 * issuing office and issue date feed two contradiction rules. Scoring must run
 * last because it reads the household the previous stage resolved.
 *
 * THE RE-SCORING FAN-OUT
 * ----------------------
 * `household_reconcile` does not score one application. When a new application
 * joins a component, every application in that component is re-scored, because
 * a contradiction is a property of the family and not of one upload — a sibling
 * declaring a different income makes BOTH applications worth looking at, and the
 * one that was already in the queue must move. This is the single most important
 * behaviour in the pipeline and the easiest to get wrong by scoring only the
 * document that triggered the job.
 */

import type { PipelineStage } from '@scholarshield/shared';

import { recordAudit } from '../audit.js';
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import {
  componentFor,
  detectComponents,
  edgeKey,
  type HouseholdComponent,
} from '../household/components.js';
import { loadRulesConfig } from '../household/config.js';
import { normalizeIdentity } from '../household/normalize.js';
import {
  linkedPairs,
  type MatchField,
  type ResolutionInput,
} from '../household/resolve.js';
import { evaluateRules, type ScorableApplication } from '../household/rules.js';
import type { DocumentLoader } from '../storage.js';
import * as ocrClient from './ocrClient.js';

export interface StageContext {
  loadDocument: DocumentLoader;
  ocr: Pick<typeof ocrClient, 'extract' | 'forensics'>;
}

interface DocumentRow {
  id: string;
  application_id: string;
  storage_key: string;
  content_type: string;
  cycle: string;
}

async function documentRow(documentId: string): Promise<DocumentRow> {
  const { rows } = await query<DocumentRow>(
    `SELECT d.id, d.application_id, d.storage_key, d.content_type, a.cycle
       FROM documents d
       JOIN applications a ON a.id = d.application_id
      WHERE d.id = $1`,
    [documentId],
  );
  const row = rows[0];
  if (!row) throw new Error(`document ${documentId} not found`);
  return row;
}

// ------------------------------------------------------------------ 1. OCR

export async function ocrExtract(
  documentId: string,
  ctx: StageContext,
): Promise<ocrClient.ExtractionPayload> {
  const doc = await documentRow(documentId);
  const bytes = await ctx.loadDocument(doc.storage_key);
  const extraction = await ctx.ocr.extract(bytes, `${documentId}.jpg`);

  await query(
    `UPDATE documents SET extracted_fields = $2 WHERE id = $1`,
    [documentId, JSON.stringify(extraction.fields)],
  );

  return extraction;
}

// ------------------------------------------------------------ 2. Forensics

export async function forensicsAnalyze(
  documentId: string,
  ctx: StageContext,
): Promise<ocrClient.ForensicsPayload> {
  const doc = await documentRow(documentId);
  const bytes = await ctx.loadDocument(doc.storage_key);
  const report = await ctx.ocr.forensics(bytes, `${documentId}.jpg`);

  await query(
    `UPDATE documents SET forensics = $2, tamper_score = $3 WHERE id = $1`,
    [documentId, JSON.stringify(report), report.tamperScore],
  );

  return report;
}

// --------------------------------------------------------- 3. Verification

/**
 * Generate the manual verification link.
 *
 * There is no scraping adapter and no automated portal call. The shipped path
 * is a pre-filled link a reviewer opens themselves, and the result stays
 * `manual_check_required` until a human records otherwise — which is why the
 * status is not derived from anything this stage computes.
 */
export async function verificationCheck(
  documentId: string,
): Promise<{ status: string; manualCheckUrl: string }> {
  const doc = await documentRow(documentId);

  const { rows } = await query<{ certificate_id: string | null; district: string }>(
    `SELECT certificate_id, district FROM applications WHERE id = $1`,
    [doc.application_id],
  );
  const application = rows[0];
  if (!application) throw new Error(`application ${doc.application_id} not found`);

  const params = new URLSearchParams({
    certificateNo: application.certificate_id ?? '',
    district: application.district,
  });
  const manualCheckUrl = `${config.VERIFICATION_PORTAL_URL}?${params.toString()}`;

  await query(
    `INSERT INTO verification_results (application_id, adapter, status, manual_check_url)
     VALUES ($1, 'ManualLinkAdapter', 'manual_check_required', $2)
     ON CONFLICT DO NOTHING`,
    [doc.application_id, manualCheckUrl],
  );

  return { status: 'manual_check_required', manualCheckUrl };
}

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
  issuing_office: string | null;
  certificate_issue_date: string | null;
  normalized_applicant_name: string | null;
  normalized_guardian_name: string | null;
  normalized_address: string | null;
  normalized_phone: string | null;
}

async function applicationsInCycle(cycle: string): Promise<ApplicationRow[]> {
  const { rows } = await query<ApplicationRow>(
    `SELECT id, cycle, applicant_name, guardian_name, guardian_phone, address_line,
            district, declared_annual_income, declared_family_size, issuing_office,
            certificate_issue_date,
            normalized_applicant_name, normalized_guardian_name,
            normalized_address, normalized_phone
       FROM applications
      WHERE cycle = $1`,
    [cycle],
  );
  return rows;
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
  return {
    id: row.id,
    cycle: row.cycle,
    applicantName: row.applicant_name,
    declaredAnnualIncome: Number(row.declared_annual_income),
    declaredFamilySize: row.declared_family_size,
    normalizedGuardianName: row.normalized_guardian_name ?? '',
    normalizedAddress: row.normalized_address ?? '',
    issuingOffice: row.issuing_office,
    certificateIssueDate: row.certificate_issue_date,
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
export async function householdReconcile(
  documentId: string,
): Promise<ReconcileResult> {
  const doc = await documentRow(documentId);
  const rows = await ensureNormalized(await applicationsInCycle(doc.cycle));

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

  await persistComponents(doc.cycle, components);

  // Everything in the component the new application landed in — see the
  // fan-out note in this module's header.
  const touched = componentFor(components, doc.application_id);

  return {
    cycle: doc.cycle,
    applicationCount: rows.length,
    edgeCount: components.reduce((total, c) => total + c.edges.length, 0),
    componentCount: components.length,
    rescore: touched?.applicationIds ?? [doc.application_id],
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
export async function riskScore(
  documentId: string,
  applicationIds: string[],
): Promise<ScoreResult> {
  const doc = await documentRow(documentId);
  const rulesConfig = loadRulesConfig();
  const rows = await ensureNormalized(await applicationsInCycle(doc.cycle));

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
      for (const finding of findings) {
        const { rowCount } = await client.query(
          `INSERT INTO risk_flags
             (application_id, rule_id, rule_config_version, severity, weight, reason, evidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (application_id, rule_id, rule_config_version) DO NOTHING`,
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
    actorId: null,
    actorType: 'system',
    action: 'pipeline.scored',
    entityType: 'document',
    entityId: documentId,
    detail: { scored: scored.length, flagsWritten, configVersion: rulesConfig.version },
  });

  return { scored, flagsWritten };
}

export const STAGE_ORDER: readonly PipelineStage[] = [
  'ocr_extract',
  'forensics_analyze',
  'verification_check',
  'household_reconcile',
  'risk_score',
] as const;
