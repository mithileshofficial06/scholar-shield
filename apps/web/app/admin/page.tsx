import type { CycleSummary, StaffUser } from '@scholarshield/shared';
import Link from 'next/link';
import type { CSSProperties } from 'react';

import { AlertIcon, LockIcon } from '../components/Icons';
import { apiGet, getSession } from '../lib/session';
import { ImportForm } from './ImportForm';
import { InviteForm } from './InviteForm';
import { RetryButton, StaffAccessButton, WithdrawInviteButton } from './RowActions';

/**
 * The admin console.
 *
 * Everything here already existed as API routes an admin could only reach with
 * curl: inviting reviewers, importing a spreadsheet, retrying a stalled document,
 * reading the rule weights. The page is a server component, so the session token
 * never reaches the browser; the actions post through the session proxy.
 *
 * Reviewers can open it too and see the pipeline and the rules — both are
 * staff-readable in the API — but staff management and import are admin-only
 * there, and are shown as such here rather than as broken buttons.
 */

interface RulesResponse {
  version: string;
  note: string;
  config: {
    scholarshipIncomeCeiling: number;
    highSeverityScoreThreshold: number;
    rules: Record<string, { enabled: boolean; severity: 'low' | 'medium' | 'high'; weight: number; note?: string }>;
  };
}

interface DeadLetter {
  documentId: string;
  applicationId: string;
  stage: string;
  attempts: number;
  lastError: string | null;
  finishedAt: string | null;
}

const d = (n: number) => ({ '--d': n }) as CSSProperties;
const inr = (value: number) => `₹${value.toLocaleString('en-IN')}`;

export default async function AdminPage() {
  const session = await getSession();
  if (!session || session.role === 'applicant') {
    return (
      <Locked
        title="Staff sign-in required"
        body="The admin console is for committee staff."
        action={
          <Link href="/login?next=/admin" className="btn btn-primary">
            Staff sign in
          </Link>
        }
      />
    );
  }

  const isAdmin = session.role === 'admin';
  const [cycles, rules, deadLetters, users, me] = await Promise.all([
    apiGet<{ items: CycleSummary[]; current: string }>('/admin/cycles'),
    apiGet<RulesResponse>('/admin/rules'),
    apiGet<{ items: DeadLetter[] }>('/pipeline/dead-letters'),
    isAdmin ? apiGet<{ items: StaffUser[] }>('/admin/users') : Promise.resolve(null),
    apiGet<{ sub: string }>('/auth/me'),
  ]);
  // The API refuses self-deactivation too; this just avoids offering it.
  const viewerId = me.kind === 'ok' ? me.data.sub : null;

  if (cycles.kind === 'unreachable') {
    return <Locked title="The API is not responding" body="Start it with npm run dev, then reload this page." />;
  }

  const cycleItems = cycles.kind === 'ok' ? cycles.data.items : [];
  const currentCycle = cycles.kind === 'ok' ? cycles.data.current : '';
  const stuck = deadLetters.kind === 'ok' ? deadLetters.data.items : [];
  const staff = users?.kind === 'ok' ? users.data.items : [];
  const pendingInvites = staff.filter((u) => !u.activatedAt && !u.deactivatedAt).length;
  const current = cycleItems.find((c) => c.cycle === currentCycle);

  const stats = [
    { label: `Applications · ${currentCycle || 'current cycle'}`, value: current?.applications ?? 0, tone: '' },
    { label: 'Awaiting review', value: current?.awaitingReview ?? 0, tone: 'sev-medium' },
    { label: 'Stuck in the pipeline', value: stuck.length, tone: stuck.length ? 'sev-high' : 'sev-low' },
    { label: 'Rule config', value: rules.kind === 'ok' ? rules.data.version : '—', tone: 'is-brand' },
  ];

  return (
    <>
      <section className="page-hero">
        <div className="page-hero-bg" aria-hidden="true" />
        <div className="container">
          <span className="eyebrow rise" style={d(0)}>
            <span className="status-dot is-live" aria-hidden="true" />
            Admin console · signed in as {session.role}
          </span>
          <h1 className="page-title rise" style={d(1)}>
            Administration
          </h1>
          <p className="page-lede rise" style={d(2)}>
            Staff, intake, the pipeline and the rules. Nothing here decides an application — decisions
            are made one at a time, with a written reason, from the review queue.
          </p>
          <nav className="admin-jump rise" style={d(3)} aria-label="Sections">
            <a href="#cycles">Cycles</a>
            <a href="#pipeline">Pipeline{stuck.length ? ` · ${stuck.length}` : ''}</a>
            <a href="#staff">Staff{pendingInvites ? ` · ${pendingInvites} invited` : ''}</a>
            <a href="#rules">Rules</a>
          </nav>
        </div>
      </section>

      <section className="section admin-section">
        <div className="container">
          <div className="stat-row">
            {stats.map((stat, index) => (
              <div key={stat.label} className="card stat-card rise" style={d(index + 2)}>
                <p className="stat-label">{stat.label}</p>
                <p className={`stat-value tabular ${stat.tone}`}>{stat.value}</p>
              </div>
            ))}
          </div>

          {/* ------------------------------------------------------------ cycles */}
          <AdminPanel id="cycles" title="Cycles" subtitle="Applications per admission cycle, and bulk intake from a spreadsheet.">
            {cycleItems.length === 0 ? (
              <p className="panel-empty">No applications yet.</p>
            ) : (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Cycle</th>
                      <th className="num">Applications</th>
                      <th className="num">Awaiting review</th>
                      <th className="num">Decided</th>
                      <th className="num">Flagged</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {cycleItems.map((c) => (
                      <tr key={c.cycle}>
                        <td data-label="Cycle">
                          <strong>{c.cycle}</strong>
                          {c.cycle === currentCycle ? <span className="tag">current</span> : null}
                        </td>
                        <td data-label="Applications" className="num tabular">{c.applications}</td>
                        <td data-label="Awaiting review" className="num tabular">{c.awaitingReview}</td>
                        <td data-label="Decided" className="num tabular">{c.decided}</td>
                        <td data-label="Flagged" className="num tabular">{c.flagged}</td>
                        <td className="num">
                          <Link href={`/dashboard?cycle=${c.cycle}`} className="text-link">
                            Open queue
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="admin-subsection">
              <h3>Import from a spreadsheet</h3>
              {isAdmin ? (
                <ImportForm defaultCycle={currentCycle} />
              ) : (
                <p className="admin-note">
                  <LockIcon /> Importing applications is limited to admins.
                </p>
              )}
            </div>
          </AdminPanel>

          {/* ---------------------------------------------------------- pipeline */}
          <AdminPanel
            id="pipeline"
            title="Pipeline"
            subtitle="Documents a stage gave up on after its retries. Their applications are not in the queue until they get through."
          >
            {deadLetters.kind !== 'ok' ? (
              <p className="panel-empty">The pipeline state could not be loaded.</p>
            ) : stuck.length === 0 ? (
              <p className="admin-ok">Nothing stuck. Every uploaded document has been processed or is on its way.</p>
            ) : (
              <ul className="admin-list">
                {stuck.map((item) => (
                  <li key={`${item.documentId}-${item.stage}`} className="admin-item is-alert">
                    <div>
                      <p className="admin-item-title">
                        <span className="sev-pill sev-high">{item.stage.replaceAll('_', ' ')}</span>
                        <Link href={`/dashboard/${item.applicationId}`} className="text-link">
                          Open application
                        </Link>
                      </p>
                      <p className="admin-item-detail data">{item.lastError ?? 'No error recorded.'}</p>
                      <p className="admin-item-meta">
                        {item.attempts} attempt{item.attempts === 1 ? '' : 's'}
                        {item.finishedAt ? ` · gave up ${new Date(item.finishedAt).toLocaleString('en-IN')}` : ''}
                      </p>
                    </div>
                    <RetryButton documentId={item.documentId} stage={item.stage} />
                  </li>
                ))}
              </ul>
            )}
          </AdminPanel>

          {/* ------------------------------------------------------------- staff */}
          <AdminPanel id="staff" title="Staff" subtitle="Reviewers and admins. Accounts are invitation-only; each invitee sets their own password.">
            {!isAdmin ? (
              <p className="admin-note">
                <LockIcon /> Managing staff is limited to admins.
              </p>
            ) : users?.kind !== 'ok' ? (
              <p className="panel-empty">Staff could not be loaded.</p>
            ) : (
              <>
                <ul className="admin-list">
                  {staff.map((user) => (
                    <li key={user.id} className="admin-item">
                      <div>
                        <p className="admin-item-title">
                          <strong>{user.email}</strong>
                          <span className="tag">{user.role}</span>
                          {user.deactivatedAt ? (
                            <span className="sev-pill sev-high">deactivated</span>
                          ) : user.activatedAt ? (
                            <span className="sev-pill sev-low">active</span>
                          ) : (
                            <span className="sev-pill sev-medium">invited</span>
                          )}
                        </p>
                        <p className="admin-item-meta">
                          {user.deactivatedAt
                            ? `Deactivated ${new Date(user.deactivatedAt).toLocaleDateString('en-IN')}`
                            : user.activatedAt
                            ? `Active since ${new Date(user.activatedAt).toLocaleDateString('en-IN')}`
                            : user.inviteExpiresAt
                              ? `Invitation expires ${new Date(user.inviteExpiresAt).toLocaleDateString('en-IN')}`
                              : 'Invitation withdrawn'}
                        </p>
                      </div>
                      {!user.activatedAt && user.inviteExpiresAt ? <WithdrawInviteButton userId={user.id} /> : null}
                      {user.activatedAt && user.id !== viewerId ? (
                        <StaffAccessButton userId={user.id} deactivated={Boolean(user.deactivatedAt)} />
                      ) : null}
                    </li>
                  ))}
                </ul>
                <div className="admin-subsection">
                  <h3>Invite someone</h3>
                  <InviteForm />
                </div>
              </>
            )}
          </AdminPanel>

          {/* ------------------------------------------------------------- rules */}
          <AdminPanel
            id="rules"
            title={`Rules${rules.kind === 'ok' ? ` · ${rules.data.version}` : ''}`}
            subtitle="The weights every flag is scored with. Read-only here by design: a change is a new version file, so past scores stay reproducible."
          >
            {rules.kind !== 'ok' ? (
              <p className="panel-empty">The rule configuration could not be loaded.</p>
            ) : (
              <>
                <p className="admin-note">
                  Income ceiling {inr(rules.data.config.scholarshipIncomeCeiling)} · high-severity band from a score of{' '}
                  {rules.data.config.highSeverityScoreThreshold}
                </p>
                <ul className="rule-list">
                  {Object.entries(rules.data.config.rules)
                    .sort(([, a], [, b]) => b.weight - a.weight)
                    .map(([id, rule]) => (
                      <li key={id} className={`rule-item${rule.enabled ? '' : ' is-disabled'}`}>
                        <details>
                          <summary>
                            <span className="rule-weight tabular">+{rule.weight}</span>
                            <span className={`sev-pill sev-${rule.severity}`}>{rule.severity}</span>
                            <span className="data rule-id">{id}</span>
                            {rule.enabled ? null : <span className="tag">disabled</span>}
                          </summary>
                          {rule.note ? <p>{rule.note}</p> : null}
                        </details>
                      </li>
                    ))}
                </ul>
              </>
            )}
          </AdminPanel>
        </div>
      </section>
    </>
  );
}

function AdminPanel({
  id,
  title,
  subtitle,
  children,
}: {
  id: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="card panel admin-panel">
      <header className="panel-head">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </header>
      {children}
    </section>
  );
}

function Locked({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <section className="section auth-section">
      <div className="container auth-shell">
        <div className="card auth-card">
          <span className="auth-icon">{action ? <LockIcon /> : <AlertIcon />}</span>
          <h1>{title}</h1>
          <p className="auth-lede">{body}</p>
          {action}
        </div>
      </div>
    </section>
  );
}
