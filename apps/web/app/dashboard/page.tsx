import type { QueueItem } from '@scholarshield/shared';
import type { CSSProperties, ReactNode } from 'react';
import { AlertIcon, DatabaseIcon, LockIcon, ServerIcon } from '../components/Icons';
import { QueueTable } from './QueueTable';

/**
 * Reviewer risk queue.
 *
 * Server component so the queue fetch never reaches the browser. The detail
 * view, household graph, and decision flow come with the review workflow.
 */

type QueueState =
  | { kind: 'ok'; items: QueueItem[] }
  | { kind: 'unauthenticated' }
  | { kind: 'unreachable' }
  | { kind: 'error'; status: number };

async function fetchQueue(): Promise<QueueState> {
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${base}/queue`, { cache: 'no-store' });
    // 401 means the API answered — it is up, we are just not signed in. Reporting
    // that as "unreachable" sends someone to restart a server that is running.
    if (res.status === 401 || res.status === 403) return { kind: 'unauthenticated' };
    if (!res.ok) return { kind: 'error', status: res.status };
    const data = (await res.json()) as { items: QueueItem[] };
    return { kind: 'ok', items: data.items ?? [] };
  } catch {
    return { kind: 'unreachable' };
  }
}

const d = (n: number) => ({ '--d': n }) as CSSProperties;

export default async function DashboardPage() {
  const state = await fetchQueue();
  const items = state.kind === 'ok' ? state.items : [];
  const live = state.kind === 'ok';

  const topScore = items.reduce((max, item) => Math.max(max, item.riskScore), 0) || 1;
  const highCount = items.filter((i) => i.highSeverityCount > 0).length;
  const flaggedCount = items.filter((i) => i.flagCount > 0).length;

  const stats = [
    { label: 'In queue', value: live ? String(items.length) : '—', tone: live ? '' : 'muted' },
    // Severity colour only once there is a real number; a red dash reads as a risk bar.
    { label: 'High severity', value: live ? String(highCount) : '—', tone: live ? 'sev-high' : 'muted' },
    { label: 'Carrying flags', value: live ? String(flaggedCount) : '—', tone: live ? 'sev-medium' : 'muted' },
    { label: 'Rule config', value: 'v1', tone: 'is-brand' },
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

          {state.kind === 'ok' && items.length > 0 ? (
            <QueueTable items={items} topScore={topScore} />
          ) : (
            <div className="queue-locked">
              <SkeletonRows />
              <StateCard state={state} />
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function StateCard({ state }: { state: QueueState }) {
  let icon: ReactNode;
  let title: string;
  let body: ReactNode;
  let tone = 'is-brand';

  switch (state.kind) {
    case 'unauthenticated':
      icon = <LockIcon />;
      title = 'Reviewer sign-in required';
      body = (
        <>
          The API is running and answered, but this session carries no staff token. The sign-in
          page is the next build step — the queue appears here as soon as it lands.
        </>
      );
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
      body = <>The API is up but failed this request. Check its terminal for the error.</>;
      break;
    default:
      icon = <DatabaseIcon />;
      title = 'No applications awaiting review';
      body = (
        <>
          Load the synthetic corpus through the pipeline with <code>npm run seed -- --inline</code>.
        </>
      );
  }

  return (
    <div className={`card state-card ${tone} rise`} style={d(6)}>
      <span className="state-icon">{icon}</span>
      <h2>{title}</h2>
      <p>{body}</p>
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
