import type { QueueItem } from '@scholarshield/shared';

/**
 * Reviewer risk queue.
 *
 * Server component so the queue fetch never reaches the browser. Week 6 adds the
 * detail view, the household graph, and the decision flow.
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

function emptyCopy(state: QueueState): { headline: string; hint: string } {
  switch (state.kind) {
    case 'ok':
      return {
        headline: 'No applications awaiting review',
        hint: 'Load the synthetic corpus with `npm run seed`.',
      };
    case 'unauthenticated':
      return {
        headline: 'Reviewer sign-in required',
        hint: 'The API answered but this session carries no staff token. Sign-in lands in Week 6.',
      };
    case 'unreachable':
      return {
        headline: 'API unreachable',
        hint: 'Start it with `npm run dev`.',
      };
    case 'error':
      return {
        headline: `API returned ${state.status}`,
        hint: 'Check the API logs.',
      };
  }
}

function severityOf(item: QueueItem): 'high' | 'medium' | 'low' {
  if (item.highSeverityCount > 0) return 'high';
  if (item.flagCount > 0) return 'medium';
  return 'low';
}

export default async function DashboardPage() {
  const state = await fetchQueue();
  const items = state.kind === 'ok' ? state.items : [];

  const topScore = items.reduce((max, item) => Math.max(max, item.riskScore), 0) || 1;
  const highCount = items.filter((i) => i.highSeverityCount > 0).length;
  const flaggedCount = items.filter((i) => i.flagCount > 0).length;

  return (
    <>
      <section className="hero" style={{ paddingBottom: '2rem' }}>
        <div className="hero-copy">
          <p className="eyebrow">Reviewer console</p>
          <h1 className="display">Queue</h1>
          <p className="lede">
            Ordered by score, then oldest first. A high score means{' '}
            <strong>review this sooner</strong> — nothing more. Every decision requires a typed
            reason and writes to an append-only audit log.
          </p>
        </div>
      </section>

      <section className="section" style={{ paddingTop: '2.5rem' }}>
        <div className="metrics-strip">
          <div className="metric">
            <div className="metric-value">{items.length}</div>
            <div className="metric-label">In queue</div>
          </div>
          <div className="metric">
            <div className="metric-value sev-high">{highCount}</div>
            <div className="metric-label">High severity</div>
          </div>
          <div className="metric">
            <div className="metric-value sev-medium">{flaggedCount}</div>
            <div className="metric-label">Carrying flags</div>
          </div>
          <div className="metric">
            <div className="metric-value">v1</div>
            <div className="metric-label">Rule config</div>
          </div>
        </div>

        {items.length === 0 ? (
          <div className="empty-state">
            <p>{emptyCopy(state).headline}</p>
            <p className="hint">{emptyCopy(state).hint}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Score</th>
                  <th>Severity</th>
                  <th>Applicant</th>
                  <th>District</th>
                  <th>Leading signal</th>
                  <th>Flags</th>
                  <th>Filed</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const severity = severityOf(item);
                  const pct = `${Math.round((item.riskScore / topScore) * 100)}%`;
                  return (
                    <tr key={item.id}>
                      <td>
                        <div className={`score-cell sev-${severity}`}>
                          <span className="score-value">{item.riskScore.toFixed(0)}</span>
                          <span className="score-bar">
                            <span style={{ ['--pct' as string]: pct }} />
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className={`badge sev-${severity}`}>{severity}</span>
                      </td>
                      <td className="is-primary">{item.applicantName}</td>
                      <td>{item.district}</td>
                      <td>{item.topFlagReason ?? '—'}</td>
                      <td>
                        {item.flagCount}
                        {item.highSeverityCount > 0 ? ` · ${item.highSeverityCount} high` : ''}
                      </td>
                      <td>{new Date(item.submittedAt).toLocaleDateString('en-IN')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
