import type { CycleSummary, QueueItem } from '@scholarshield/shared';
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';

import { AlertIcon, DatabaseIcon, LockIcon, ServerIcon } from '../components/Icons';
import { apiGet, type ApiResult } from '../lib/session';
import { QueueFilters } from './QueueFilters';
import { QueueTable } from './QueueTable';

/**
 * Reviewer risk queue.
 *
 * A server component, so the queue and the session token never reach the
 * browser. Filters arrive as search params and go straight into the API query;
 * nothing is filtered here, which is what keeps the total honest.
 */

interface QueuePage {
  items: QueueItem[];
  total: number;
  limit: number;
  offset: number;
}

const d = (n: number) => ({ '--d': n }) as CSSProperties;

const FILTER_KEYS = ['status', 'severity', 'cycle', 'district', 'ruleId', 'q', 'offset'] as const;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = params[key];
    if (typeof value === 'string' && value !== '') query.set(key, value);
  }
  query.set('limit', '50');

  const queue = await apiGet<QueuePage>(`/queue?${query.toString()}`);

  // Facets are only fetched for a live session; without one the page is a
  // sign-in prompt and these would be three more 401s.
  const [rules, districts, cycles, rulesConfig] =
    queue.kind === 'ok'
      ? await Promise.all([
          apiGet<{ items: { ruleId: string; count: number }[] }>('/queue/rules'),
          apiGet<{ items: string[] }>('/queue/districts'),
          apiGet<{ items: CycleSummary[] }>('/admin/cycles'),
          apiGet<{ version: string }>('/admin/rules'),
        ])
      : [null, null, null, null];

  const items = queue.kind === 'ok' ? queue.data.items : [];
  const total = queue.kind === 'ok' ? queue.data.total : 0;
  const live = queue.kind === 'ok';

  const topScore = items.reduce((max, item) => Math.max(max, item.riskScore), 0) || 1;
  const highCount = items.filter((i) => i.highSeverityCount > 0).length;
  const flaggedCount = items.filter((i) => i.flagCount > 0).length;

  const stats = [
    { label: 'Matching the filter', value: live ? String(total) : '—', tone: live ? '' : 'muted' },
    { label: 'High severity', value: live ? String(highCount) : '—', tone: live ? 'sev-high' : 'muted' },
    { label: 'Carrying flags', value: live ? String(flaggedCount) : '—', tone: live ? 'sev-medium' : 'muted' },
    // Read from the API, not written here: it went stale at every version bump.
    { label: 'Rule config', value: rulesConfig?.kind === 'ok' ? rulesConfig.data.version : '—', tone: 'is-brand' },
  ];

  return (
    <>
      <section className="page-hero">
        <div className="page-hero-bg" aria-hidden="true" />
        <div className="container">
          <span className="eyebrow rise" style={d(0)}>
            <span className={`status-dot ${live ? 'is-live' : 'is-idle'}`} aria-hidden="true" />
            Reviewer console · {live ? 'connected' : 'not connected'}
          </span>
          <h1 className="page-title rise" style={d(1)}>
            Risk queue
          </h1>
          <p className="page-lede rise" style={d(2)}>
            Ordered by score, then oldest first. A high score means <strong>review this sooner</strong>{' '}
            — nothing more. Every decision needs a typed reason and lands in an append-only audit log.
          </p>
        </div>
      </section>

      <section className="section queue-section">
        <div className="container">
          <div className="stat-row">
            {stats.map((stat, index) => (
              <div key={stat.label} className="card stat-card rise" style={d(index + 2)}>
                <p className="stat-label">{stat.label}</p>
                <p className={`stat-value tabular ${stat.tone}`}>{stat.value}</p>
              </div>
            ))}
          </div>

          {live ? (
            <QueueFilters
              rules={rules?.kind === 'ok' ? rules.data.items : []}
              districts={districts?.kind === 'ok' ? districts.data.items : []}
              cycles={cycles?.kind === 'ok' ? cycles.data.items.map((c) => c.cycle) : []}
              total={total}
            />
          ) : null}

          {live && items.length > 0 ? (
            <QueueTable items={items} topScore={topScore} />
          ) : (
            <div className="queue-locked">
              <SkeletonRows />
              <StateCard state={queue} />
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function StateCard({ state }: { state: ApiResult<QueuePage> }) {
  let icon: ReactNode = <DatabaseIcon />;
  let title = 'No applications match this filter';
  let body: ReactNode = (
    <>
      Clear the filters, or load the synthetic corpus with <code>npm run seed -- --inline</code>.
    </>
  );
  let tone = 'is-brand';
  let action: ReactNode = null;

  switch (state.kind) {
    case 'unauthenticated':
      icon = <LockIcon />;
      title = 'Reviewer sign-in required';
      body = <>The queue, and every application in it, is visible only to signed-in reviewers.</>;
      action = (
        <Link href="/login?next=/dashboard" className="btn btn-primary">
          Sign in
        </Link>
      );
      break;
    case 'forbidden':
      icon = <LockIcon />;
      title = 'This account cannot review';
      tone = 'is-warn';
      body = <>Your session is valid but lacks the reviewer role. Ask an administrator to grant it.</>;
      break;
    case 'unreachable':
      icon = <ServerIcon />;
      title = 'API unreachable';
      tone = 'is-warn';
      body = (
        <>
          Nothing answered at the API address. Start it with <code>npm run dev</code> and refresh.
        </>
      );
      break;
    case 'error':
      icon = <AlertIcon />;
      title = `API returned ${state.status}`;
      tone = 'is-danger';
      body = <>{state.message ?? 'The API is up but failed this request. Check its terminal.'}</>;
      break;
    case 'ok':
      break;
  }

  return (
    <div className={`card state-card ${tone} rise`} style={d(6)}>
      <span className="state-icon">{icon}</span>
      <h2>{title}</h2>
      <p>{body}</p>
      {action ? <div className="state-action">{action}</div> : null}
    </div>
  );
}

/** Placeholder rows behind the state card, so the page shows the queue's shape. */
function SkeletonRows() {
  return (
    <div className="card skeleton" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="skeleton-row">
          <span style={{ width: '6%' }} />
          <span style={{ width: '14%' }} />
          <span style={{ width: '10%' }} />
          <span style={{ width: '22%' }} />
          <span style={{ width: '34%' }} />
        </div>
      ))}
    </div>
  );
}
