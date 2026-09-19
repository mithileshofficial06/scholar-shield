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

import { config } from '../config.js';
import { query } from '../db.js';
import {
  reconcileCycle,
  scoreApplications,
  type ReconcileResult,
  type ScoreResult,
} from '../household/service.js';
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
    `UPDATE documents SET extracted_fields = $2, ocr_report = $3 WHERE id = $1`,
    [
      documentId,
      JSON.stringify(extraction.fields),
      JSON.stringify({
        incomeWordsMismatch: extraction.incomeWordsMismatch,
        pageConfidence: extraction.pageConfidence,
        wordCount: extraction.wordCount,
        skewCorrectedDegrees: extraction.skewCorrectedDegrees,
      }),
    ],
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

  // Only the first time. There is no unique key on the table, and a re-run —
  // a retried job, a re-uploaded document — used to append a fresh
  // manual_check_required row, which as the newest row silently replaced any
  // result a reviewer had already recorded.
  await query(
    `INSERT INTO verification_results (application_id, adapter, status, manual_check_url)
     SELECT $1, 'ManualLinkAdapter', 'manual_check_required', $2
      WHERE NOT EXISTS (SELECT 1 FROM verification_results WHERE application_id = $1)`,
    [doc.application_id, manualCheckUrl],
  );

  return { status: 'manual_check_required', manualCheckUrl };
}

// ------------------------------------------------- 4. Household reconcile

/**
 * Resolve the cycle this document belongs to.
 *
 * The work lives in household/service.ts because a CSV import and a reviewer
 * rejecting a merge need exactly the same pass without a document to key it on.
 */
export async function householdReconcile(documentId: string): Promise<ReconcileResult> {
  const doc = await documentRow(documentId);
  return reconcileCycle(doc.cycle, doc.application_id);
}

// ------------------------------------------------------------ 5. Scoring

export async function riskScore(
  documentId: string,
  applicationIds: string[],
): Promise<ScoreResult> {
  const doc = await documentRow(documentId);
  return scoreApplications(doc.cycle, applicationIds, {
    actorId: null,
    actorType: 'system',
    entityType: 'document',
    entityId: documentId,
  });
}

export type { ReconcileResult, ScoreResult };

export const STAGE_ORDER: readonly PipelineStage[] = [
  'ocr_extract',
  'forensics_analyze',
  'verification_check',
  'household_reconcile',
  'risk_score',
] as const;
