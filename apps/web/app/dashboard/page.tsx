import type { QueueItem } from '@scholarshield/shared';

/**
 * Reviewer risk queue — Week 1 shell.
 *
 * Server component so the queue fetch never reaches the browser. Week 6 adds the
 * detail view, the household graph, and the decision flow; for now this renders
 * the real shape from the real endpoint, and an empty state when the API is down.
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

function emptyMessage(state: Exclude<QueueState, { kind: 'ok' }> | { kind: 'ok' }): string {
  switch (state.kind) {
    case 'ok':
      return 'No applications awaiting review. Run `npm run seed` to load the synthetic corpus.';
    case 'unauthenticated':
      return 'Sign in as a reviewer to see the queue. Staff sign-in lands in Week 6.';
    case 'unreachable':
      return 'API unreachable — start it with `npm run dev`.';
    case 'error':
      return `API returned ${state.status}. Check the API logs.`;
  }
}

function severityClass(item: QueueItem): string {
  if (item.highSeverityCount > 0) return 'sev-high';
  if (item.flagCount > 0) return 'sev-medium';
  return 'sev-low';
}

export default async function DashboardPage() {
  const state = await fetchQueue();
  const items = state.kind === 'ok' ? state.items : [];

  return (
    <>
      <div className="notice">
        Score sets <strong>review order only</strong>. Every decision requires a typed reason and is
        written to an append-only audit log.
      </div>

      <div className="card">
        <h2>Review queue</h2>

        {items.length === 0 ? (
          <p className="empty">{emptyMessage(state)}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Score</th>
                <th>Applicant</th>
                <th>District</th>
                <th>Top flag</th>
                <th>Flags</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className={severityClass(item)}>{item.riskScore.toFixed(1)}</td>
                  <td>{item.applicantName}</td>
                  <td>{item.district}</td>
                  <td>{item.topFlagReason ?? '—'}</td>
                  <td>
                    {item.flagCount}
                    {item.highSeverityCount > 0 ? ` (${item.highSeverityCount} high)` : ''}
                  </td>
                  <td>{new Date(item.submittedAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
