/**
 * Reviewer-facing serialization.
 *
 * The applicant boundary lives in serializers.ts and is the one that matters for
 * disclosure. This file is the other half: reviewers see everything, but they
 * should see it in the shape `@scholarshield/shared` promises, so the web app
 * cannot drift onto raw column names.
 *
 * Numeric columns arrive from pg as strings (numeric and bigint are not safe in
 * a JS number by default), so every one is converted explicitly here rather than
 * relied on to coerce somewhere downstream.
 */

import type {
  ApplicationDetail,
  ApplicationStatus,
  DocumentSummary,
  FlagSeverity,
  Household,
  HouseholdEdge,
  MatchField,
  ReviewDecision,
  ReviewRecord,
  RiskFlag,
  VerificationResult,
  VerificationStatus,
} from '@scholarshield/shared';

export interface FullApplicationRow {
  id: string;
  cycle: string;
  status: ApplicationStatus;
  applicant_name: string;
  guardian_name: string;
  guardian_phone: string | null;
  address_line: string;
  district: string;
  pincode: string | null;
  declared_annual_income: string;
  declared_family_size: number;
  certificate_id: string | null;
  issuing_office: string | null;
  certificate_issue_date: string | null;
  risk_score: string;
  scored_at: Date | string | null;
  submitted_at: Date | string;
  household_id: string | null;
}

export interface FlagRow {
  id: string;
  application_id: string;
  rule_id: string;
  rule_config_version: string;
  severity: FlagSeverity;
  weight: string;
  reason: string;
  evidence: Record<string, unknown> | null;
  created_at: Date | string;
}

export interface DocumentRow {
  id: string;
  kind: DocumentSummary['kind'];
  content_type: string;
  byte_size: string;
  sha256: string;
  extracted_fields: DocumentSummary['extractedFields'];
  tamper_score: string | null;
  purged_at: Date | string | null;
}

export interface VerificationRow {
  id: string;
  application_id: string;
  adapter: string;
  status: VerificationStatus;
  manual_check_url: string;
  checked_at: Date | string | null;
  notes: string | null;
}

export interface EdgeRow {
  id: string;
  application_a_id: string;
  application_b_id: string;
  match_field: MatchField;
  similarity: string;
  weight: string;
  rejected_at: Date | string | null;
  rejected_reason: string | null;
}

export interface ReviewRow {
  id: string;
  application_id: string;
  reviewer_id: string;
  decision: ReviewDecision;
  reason: string;
  created_at: Date | string;
}

const iso = (value: Date | string) => new Date(value).toISOString();
const isoOrNull = (value: Date | string | null) => (value === null ? null : iso(value));

export function toRiskFlag(row: FlagRow): RiskFlag {
  return {
    id: row.id,
    applicationId: row.application_id,
    ruleId: row.rule_id,
    ruleConfigVersion: row.rule_config_version,
    severity: row.severity,
    weight: Number(row.weight),
    reason: row.reason,
    evidence: row.evidence ?? {},
    createdAt: iso(row.created_at),
  };
}

export function toDocumentSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    kind: row.kind,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    extractedFields: row.extracted_fields,
    tamperScore: row.tamper_score === null ? null : Number(row.tamper_score),
    purgedAt: isoOrNull(row.purged_at),
  };
}

export function toVerificationResult(row: VerificationRow): VerificationResult {
  return {
    id: row.id,
    applicationId: row.application_id,
    adapter: row.adapter,
    status: row.status,
    manualCheckUrl: row.manual_check_url,
    checkedAt: isoOrNull(row.checked_at),
    notes: row.notes,
  };
}

export function toHouseholdEdge(row: EdgeRow): HouseholdEdge {
  return {
    id: row.id,
    applicationAId: row.application_a_id,
    applicationBId: row.application_b_id,
    matchField: row.match_field,
    similarity: Number(row.similarity),
    weight: Number(row.weight),
    rejectedAt: isoOrNull(row.rejected_at),
    rejectedReason: row.rejected_reason,
  };
}

export function toReviewRecord(row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    reviewerId: row.reviewer_id,
    decision: row.decision,
    reason: row.reason,
    createdAt: iso(row.created_at),
  };
}

export function toApplicationDetail(parts: {
  application: FullApplicationRow;
  flags: FlagRow[];
  documents: DocumentRow[];
  verification: VerificationRow | null;
  household: { id: string; cycle: string; memberCount: number; applicationIds: string[]; edges: EdgeRow[] } | null;
}): ApplicationDetail {
  const a = parts.application;

  const household: Household | null = parts.household
    ? {
        id: parts.household.id,
        cycle: parts.household.cycle,
        memberCount: parts.household.memberCount,
        applicationIds: parts.household.applicationIds,
        edges: parts.household.edges.map(toHouseholdEdge),
      }
    : null;

  return {
    id: a.id,
    cycle: a.cycle,
    status: a.status,
    declared: {
      applicantName: a.applicant_name,
      guardianName: a.guardian_name,
      guardianPhone: a.guardian_phone,
      addressLine: a.address_line,
      district: a.district,
      pincode: a.pincode,
      declaredAnnualIncome: Number(a.declared_annual_income),
      declaredFamilySize: a.declared_family_size,
      certificateId: a.certificate_id,
      issuingOffice: a.issuing_office,
      certificateIssueDate: a.certificate_issue_date,
    },
    riskScore: Number(a.risk_score),
    scoredAt: isoOrNull(a.scored_at),
    flags: parts.flags.map(toRiskFlag),
    household,
    verification: parts.verification ? toVerificationResult(parts.verification) : null,
    documents: parts.documents.map(toDocumentSummary),
    submittedAt: iso(a.submitted_at),
  };
}
