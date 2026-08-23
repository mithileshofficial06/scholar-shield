import type { QueueItem } from '@scholarshield/shared';

/**
 * Reviewer risk queue — Week 1 shell.
 *
 * Server component so the queue fetch never reaches the browser. Week 6 adds the
 * detail view, the household graph, and the decision flow; for now this renders
 * the real shape from the real endpoint, and an empty state when the API is down.
 */
async function fetchQueue(): Promise<{ items: QueueItem[]; reachable: boolean }> {
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${base}/queue`, { cache: 'no-store' });
    if (!res.ok) return { items: [], reachable: false };
    const data = (await res.json()) as { items: QueueItem[] };
    return { items: data.items ?? [], reachable: true };
  } catch {
    return { items: [], reachable: false };
  }
}

function severityClass(item: QueueItem): string {
  if (item.highSeverityCount > 0) return 'sev-high';
  if (item.flagCount > 0) return 'sev-medium';
  return 'sev-low';
}

export default async function DashboardPage() {
  const { items, reachable } = await fetchQueue();

  return (
    <>
      <div className="notice">
        Score sets <strong>review order only</strong>. Every decision requires a typed reason and is
        written to an append-only audit log.
      </div>

      <div className="card">
        <h2>Review queue</h2>

        {items.length === 0 ? (
          <p className="empty">
            {reachable
              ? 'No applications awaiting review. Run `npm run seed` to load the synthetic corpus.'
              : 'API unreachable — start it with `npm run dev` (and `npm run infra:up` for Postgres).'}
          </p>
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
