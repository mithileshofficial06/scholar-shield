/**
 * Shared contract between apps/web and apps/api.
 *
 * One rule governs everything in this file: a payload sent to an applicant must
 * never carry a score, a flag, or a household. The Applicant* types below are the
 * shapes allowed to cross that boundary, and `apps/api/test/serializer.test.ts`
 * asserts it holds at runtime — see PROJECT_REPORT.md §11.
 */

// ---------------------------------------------------------------- enums

export const USER_ROLES = ['reviewer', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const APPLICATION_STATUSES = [
  'submitted',
  'processing',
  'ready_for_review',
  'approved',
  'escalated',
  'rejected',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const REVIEW_DECISIONS = ['approve', 'escalate', 'reject'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const VERIFICATION_STATUSES = [
  'manual_check_required',
  'verified',
  'mismatch',
  'unavailable',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const FLAG_SEVERITIES = ['low', 'medium', 'high'] as const;
export type FlagSeverity = (typeof FLAG_SEVERITIES)[number];

export const PIPELINE_STAGES = [
  'ocr_extract',
  'forensics_analyze',
  'verification_check',
  'household_reconcile',
  'risk_score',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const MATCH_FIELDS = [
  'guardian_name',
  'applicant_name',
  'address',
  'phone',
] as const;
export type MatchField = (typeof MATCH_FIELDS)[number];

// ---------------------------------------------------------------- core

/** What an applicant declares at submission. */
export interface DeclaredDetails {
  applicantName: string;
  guardianName: string;
  guardianPhone: string | null;
  addressLine: string;
  district: string;
  pincode: string | null;
  declaredAnnualIncome: number;
  declaredFamilySize: number;
  certificateId: string | null;
  issuingOffice: string | null;
  certificateIssueDate: string | null;
}

/** Normalized forms — what entity resolution compares. Never applicant-facing. */
export interface NormalizedIdentity {
  normalizedApplicantName: string;
  normalizedGuardianName: string;
  normalizedAddress: string;
  normalizedPhone: string | null;
}

export interface RiskFlag {
  id: string;
  applicationId: string;
  ruleId: string;
  ruleConfigVersion: string;
  severity: FlagSeverity;
  weight: number;
  /** Human-readable, shown verbatim to the reviewer. Never a bare number. */
  reason: string;
  /** The exact field values that triggered the rule. */
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface HouseholdEdge {
  id: string;
  applicationAId: string;
  applicationBId: string;
  matchField: MatchField;
  similarity: number;
  weight: number;
  /** A reviewer can reject a merge the resolver proposed. */
  rejectedAt: string | null;
  rejectedReason: string | null;
}

export interface Household {
  id: string;
  cycle: string;
  memberCount: number;
  applicationIds: string[];
  edges: HouseholdEdge[];
}

/** A household member as the reviewer's graph draws it. */
export interface HouseholdMember {
  id: string;
  applicantName: string;
  guardianName: string;
  district: string;
  declaredAnnualIncome: number;
  declaredFamilySize: number;
  riskScore: number;
  status: ApplicationStatus;
}

/** A resolved household plus the members and edges behind it. */
export interface HouseholdView {
  household: Household | null;
  members: HouseholdMember[];
  /** Edges touching these applications, including ones a reviewer rejected. */
  edges: HouseholdEdge[];
}

export interface VerificationResult {
  id: string;
  applicationId: string;
  adapter: string;
  status: VerificationStatus;
  /** Always present. The pre-filled state-portal link is the shipped path. */
  manualCheckUrl: string;
  checkedAt: string | null;
  notes: string | null;
}

export interface DocumentSummary {
  id: string;
  kind: 'income_certificate' | 'supporting';
  contentType: string;
  byteSize: number;
  sha256: string;
  /** OCR never guesses: a field it could not read arrives as null, with its confidence. */
  extractedFields: Record<string, { value: string | null; confidence: number }> | null;
  tamperScore: number | null;
  purgedAt: string | null;
}

// ---------------------------------------------------------------- reviewer views

/** Full record. Reviewer/admin only. */
export interface ApplicationDetail {
  id: string;
  cycle: string;
  status: ApplicationStatus;
  declared: DeclaredDetails;
  riskScore: number;
  scoredAt: string | null;
  flags: RiskFlag[];
  household: Household | null;
  verification: VerificationResult | null;
  documents: DocumentSummary[];
  submittedAt: string;
}

export interface QueueItem {
  id: string;
  applicantName: string;
  district: string;
  cycle: string;
  status: ApplicationStatus;
  riskScore: number;
  topFlagReason: string | null;
  flagCount: number;
  highSeverityCount: number;
  submittedAt: string;
}

export interface ReviewRecord {
  id: string;
  applicationId: string;
  reviewerId: string;
  decision: ReviewDecision;
  reason: string;
  createdAt: string;
}

// ---------------------------------------------------------------- applicant views

/**
 * Everything an applicant is permitted to see about their own application.
 * Deliberately has no risk, flag, household, or forensics field — adding one
 * here is the mistake this type exists to make visible in review.
 */
export interface ApplicantApplicationView {
  id: string;
  cycle: string;
  /** Coarse and non-revealing: submitted → under_review → decided. */
  stage: 'submitted' | 'under_review' | 'decided';
  submittedAt: string;
  documentCount: number;
}

// ---------------------------------------------------------------- requests

export interface SubmitApplicationRequest {
  cycle: string;
  declared: DeclaredDetails;
}

export interface ReviewRequest {
  decision: ReviewDecision;
  /** Enforced at the database level, not only here. */
  reason: string;
}

export interface RejectEdgeRequest {
  reason: string;
}

export interface InviteRequest {
  email: string;
  role: UserRole;
}

export interface StaffUser {
  id: string;
  email: string;
  role: UserRole;
  activatedAt: string | null;
  invitedBy: string | null;
  inviteExpiresAt: string | null;
  createdAt: string;
}

export interface CycleSummary {
  cycle: string;
  applications: number;
  awaitingReview: number;
  decided: number;
  flagged: number;
}

export interface TipRequest {
  applicationId: string | null;
  body: string;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

// ---------------------------------------------------------------- verification checklist

/**
 * Every check the engine runs on one application, including the ones that
 * passed. A flag list shows only what fired; a reviewer deciding a case also
 * needs to know what was checked and came back clean, and what could not be
 * checked at all — "no flag" and "never looked" are different things.
 *
 *   pass    — checked, and it held
 *   fail    — checked, and it did not (these are the flags)
 *   skipped — could not be checked, with the reason (nothing to compare, OCR unsure)
 *   pending — not run yet, or waiting on a person (the government-record check)
 */
export type CheckStatus = 'pass' | 'fail' | 'skipped' | 'pending';

export type CheckGroup = 'document' | 'certificate' | 'government' | 'household';

export interface ApplicationCheck {
  id: string;
  group: CheckGroup;
  label: string;
  status: CheckStatus;
  detail: string;
  /** The rule a failure raises, when the check is backed by one. */
  ruleId: string | null;
  severity: FlagSeverity | null;
  /** For certificate-against-form comparisons: both sides, as compared. */
  declared?: string | null;
  certificate?: string | null;
}

export interface ApplicationChecklist {
  applicationId: string;
  configVersion: string;
  summary: Record<CheckStatus, number>;
  checks: ApplicationCheck[];
}
