import type { QueueItem } from '@scholarshield/shared';
import Link from 'next/link';
import type { CSSProperties } from 'react';

function severityOf(item: QueueItem): 'high' | 'medium' | 'low' {
  if (item.highSeverityCount > 0) return 'high';
  if (item.flagCount > 0) return 'medium';
  return 'low';
}

const d = (n: number) => ({ '--d': n }) as CSSProperties;

/** The risk-ordered table. Rows stagger in after the page header settles. */
export function QueueTable({ items, topScore }: { items: QueueItem[]; topScore: number }) {
  return (
    <div className="card queue-card rise" style={d(6)}>
      <div className="queue-scroll">
        <table className="queue-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Score</th>
              <th scope="col">Severity</th>
              <th scope="col">Applicant</th>
              <th scope="col">Leading signal</th>
              <th scope="col">Flags</th>
              <th scope="col">Filed</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => {
              const severity = severityOf(item);
              const pct = `${Math.max(4, Math.round((item.riskScore / topScore) * 100))}%`;
              return (
                <tr key={item.id} className="row-in" style={{ '--r': Math.min(index, 12) } as CSSProperties}>
                  <td className="rank tabular">{index + 1}</td>
                  <td>
                    <div className={`score sev-${severity}`}>
                      <span className="score-num tabular">{item.riskScore.toFixed(0)}</span>
                      <span className="score-track" aria-hidden="true">
                        <span style={{ width: pct }} />
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className={`sev-pill sev-${severity}`}>{severity}</span>
                  </td>
                  <td>
                    <Link href={`/dashboard/${item.id}`} className="applicant applicant-link">
                      {item.applicantName}
                    </Link>
                    <span className="applicant-sub">{item.district}</span>
                  </td>
                  <td className="signal-cell" title={item.topFlagReason ?? undefined}>
                    <span className="signal">{item.topFlagReason ?? <span className="muted">No flags</span>}</span>
                  </td>
                  <td className="tabular">
                    {item.flagCount}
                    {item.highSeverityCount > 0 ? <span className="flag-high"> · {item.highSeverityCount} high</span> : null}
                  </td>
                  <td className="filed tabular">
                    {new Date(item.submittedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
