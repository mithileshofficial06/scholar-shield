import type { ApplicationChecklist, ApplicationDetail, HouseholdView, ReviewRecord } from '@scholarshield/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { CSSProperties } from 'react';

import { LockIcon } from '../../components/Icons';
import { apiGet } from '../../lib/session';
import { ChecklistPanel } from './ChecklistPanel';
import { DecisionForm } from './DecisionForm';
import { DocumentPanel } from './DocumentPanel';
import { HouseholdGraph } from './HouseholdGraph';
import { VerificationForm } from './VerificationForm';

/**
 * One application, as the reviewer sees it.
 *
 * Ordered by what a decision actually rests on: the contradictions and their
 * evidence first, then the household that produced them, then the document and
 * what OCR read from it, and the decision last. The score appears once, in the
 * header, because it decided when this was looked at and nothing else.
 */

type ReviewWithEmail = ReviewRecord & { reviewerEmail: string };

const d = (n: number) => ({ '--d': n }) as CSSProperties;
const inr = (value: number) => `₹${value.toLocaleString('en-IN')}`;

const STATUS_TONE: Record<string, string> = {
  approved: 'sev-low',
  rejected: 'sev-high',
  escalated: 'sev-medium',
  ready_for_review: '',
  submitted: '',
  processing: '',
};

export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await apiGet<ApplicationDetail>(`/applications/${id}`);

  if (detail.kind === 'unauthenticated' || detail.kind === 'forbidden') {
    return (
      <section className="section auth-section">
        <div className="container auth-shell">
          <div className="card auth-card">
            <span className="auth-icon">
              <LockIcon />
            </span>
            <h1>Reviewer sign-in required</h1>
            <p className="auth-lede">Applications are visible only to signed-in reviewers.</p>
            <Link href={`/login?next=/dashboard/${id}`} className="btn btn-primary auth-submit">
              Sign in
            </Link>
          </div>
        </div>
      </section>
    );
  }

  if (detail.kind === 'error' && detail.status === 404) notFound();

  if (detail.kind !== 'ok') {
    return (
      <section className="section">
        <div className="container">
          <div className="card state-card is-warn">
            <h2>This application could not be loaded</h2>
            <p>
              {detail.kind === 'unreachable'
                ? 'The API is not responding.'
                : (detail.message ?? 'The API returned an error.')}
            </p>
          </div>
        </div>
      </section>
    );
  }

  const application = detail.data;
  const [household, reviews, checklist] = await Promise.all([
    apiGet<HouseholdView>(`/applications/${id}/household`),
    apiGet<{ items: ReviewWithEmail[] }>(`/applications/${id}/reviews`),
    apiGet<ApplicationChecklist>(`/applications/${id}/checks`),
  ]);

  const severity =
    application.flags.some((f) => f.severity === 'high')
      ? 'high'
      : application.flags.length > 0
        ? 'medium'
        : 'low';

  const declared = application.declared;
  const perHead = Math.round(declared.declaredAnnualIncome / Math.max(declared.declaredFamilySize, 1));

  return (
    <>
      <section className="page-hero detail-hero">
        <div className="page-hero-bg" aria-hidden="true" />
        <div className="container">
          <Link href="/dashboard" className="back-link rise" style={d(0)}>
            ← Back to the queue
          </Link>

          <div className="detail-head rise" style={d(1)}>
            <div>
              <h1 className="page-title">{declared.applicantName}</h1>
              <p className="detail-sub">
                {declared.district} · cycle {application.cycle} · filed{' '}
                {new Date(application.submittedAt).toLocaleDateString('en-IN', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}
              </p>
            </div>

            <div className="detail-score">
              <span className={`detail-score-value tabular sev-${severity}`}>
                {application.riskScore.toFixed(0)}
              </span>
              <span className="detail-score-label">
                review priority
                <br />
                <span className={`sev-pill ${STATUS_TONE[application.status] ?? ''}`}>
                  {application.status.replaceAll('_', ' ')}
                </span>
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="section detail-section">
        <div className="container detail-layout">
          <div className="detail-main">
            <Panel
              title="Verification checks"
              subtitle="Every check run on this application — passed, failed, not checkable, or waiting."
            >
              {checklist.kind === 'ok' ? (
                <ChecklistPanel checklist={checklist.data} />
              ) : (
                <div className="panel-empty">
                  <p>The checklist could not be loaded.</p>
                </div>
              )}
            </Panel>

            <Panel
              title={`Why this surfaced${application.flags.length ? ` · ${application.flags.length}` : ''}`}
              subtitle="Each flag names the rule, its weight, and the values behind it."
            >
              {application.flags.length === 0 ? (
                <div className="panel-empty">
                  <p>
                    <strong>No flags.</strong> Nothing in this cycle contradicts what this
                    application declares.
                  </p>
                </div>
              ) : (
                <ul className="flag-list">
                  {application.flags.map((flag) => (
                    <li key={flag.id} className={`flag sev-${flag.severity}`}>
                      <div className="flag-head">
                        <span className={`sev-pill sev-${flag.severity}`}>{flag.severity}</span>
                        <span className="flag-rule data">{flag.ruleId}</span>
                        <span className="flag-weight tabular">+{flag.weight}</span>
                      </div>
                      <p className="flag-reason">{flag.reason}</p>
                      <details className="flag-evidence">
                        <summary>Evidence · rule config {flag.ruleConfigVersion}</summary>
                        <dl>
                          {Object.entries(flag.evidence).map(([key, value]) => (
                            <div key={key}>
                              <dt>{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</dt>
                              <dd className="data">
                                {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title="Household"
              subtitle="Applications the resolver joined, and the matches that joined them."
            >
              {household.kind === 'ok' ? (
                <HouseholdGraph view={household.data} applicationId={application.id} />
              ) : (
                <div className="panel-empty">
                  <p>The household could not be loaded.</p>
                </div>
              )}
            </Panel>

            <Panel title="Document" subtitle="The certificate as submitted, and what OCR read from it.">
              {application.documents.length === 0 ? (
                <div className="panel-empty">
                  <p>
                    <strong>No document.</strong> This application was imported from a spreadsheet,
                    so there is nothing to read or verify here.
                  </p>
                </div>
              ) : (
                application.documents.map((document) => (
                  <DocumentPanel key={document.id} document={document} />
                ))
              )}
            </Panel>
          </div>

          <aside className="detail-aside">
            <Panel title="Declared" compact>
              <dl className="detail-list">
                <Row label="Guardian" value={declared.guardianName} />
                <Row label="Phone" value={declared.guardianPhone ?? '—'} />
                <Row label="Address" value={declared.addressLine} />
                <Row label="PIN code" value={declared.pincode ?? '—'} />
                <Row label="Household income" value={inr(declared.declaredAnnualIncome)} strong />
                <Row label="Family size" value={String(declared.declaredFamilySize)} />
                <Row label="Per person" value={inr(perHead)} />
                <Row label="Certificate" value={declared.certificateId ?? '—'} mono />
                <Row label="Issuing office" value={declared.issuingOffice ?? '—'} />
                <Row
                  label="Issued"
                  value={
                    declared.certificateIssueDate
                      ? new Date(declared.certificateIssueDate).toLocaleDateString('en-IN')
                      : '—'
                  }
                />
              </dl>
            </Panel>

            <Panel title="Government record" compact>
              <VerificationForm applicationId={application.id} verification={application.verification} />
            </Panel>

            <Panel title="Decision" compact>
              <DecisionForm applicationId={application.id} status={application.status} />
            </Panel>

            {reviews.kind === 'ok' && reviews.data.items.length > 0 ? (
              <Panel title="Decision history" compact>
                <ul className="review-list">
                  {reviews.data.items.map((review) => (
                    <li key={review.id}>
                      <p className="review-head">
                        <span className={`sev-pill ${STATUS_TONE[`${review.decision}d`] ?? ''}`}>
                          {review.decision}
                        </span>
                        <span className="review-when">
                          {new Date(review.createdAt).toLocaleString('en-IN')}
                        </span>
                      </p>
                      <p className="review-reason">{review.reason}</p>
                      <p className="review-by">{review.reviewerEmail}</p>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}
          </aside>
        </div>
      </section>
    </>
  );
}

function Panel({
  title,
  subtitle,
  compact,
  children,
}: {
  title: string;
  subtitle?: string;
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`card panel${compact ? ' is-compact' : ''}`}>
      <header className="panel-head">
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </header>
      {children}
    </section>
  );
}

function Row({
  label,
  value,
  mono,
  strong,
}: {
  label: string;
  value: string;
  mono?: boolean;
  strong?: boolean;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={`${mono ? 'data ' : ''}${strong ? 'is-strong' : ''}`}>{value}</dd>
    </div>
  );
}
