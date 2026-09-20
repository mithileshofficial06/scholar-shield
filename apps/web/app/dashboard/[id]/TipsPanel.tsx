'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface TipView {
  id: string;
  body: string;
  createdAt: string;
  markedAbusive: boolean;
}

/**
 * Tips a reviewer sees on one application.
 *
 * Presented as unverified hearsay, because that is what it is. There is no
 * author, no score contribution and no severity — the framing is deliberate:
 * an anonymous message rendered like a system finding reads as evidence, and
 * this one carries none of the provenance a finding does.
 *
 * An abusive tip is hidden rather than deleted. The row survives because a
 * message used to harass someone is the record of that harassment, and the
 * person who marked it is on the audit log either way.
 */
export function TipsPanel({ applicationId, tips }: { applicationId: string; tips: TipView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function markAbusive(tipId: string) {
    setBusy(tipId);
    setError(null);

    const res = await fetch(`/api/proxy/tips/${tipId}/abusive`, { method: 'POST' });
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { message?: string };
      setError(payload.message ?? 'That tip could not be marked.');
      setBusy(null);
      return;
    }

    setBusy(null);
    router.refresh();
  }

  if (tips.length === 0) {
    return (
      <div className="panel-empty">
        <p>No tips about this application.</p>
      </div>
    );
  }

  return (
    <div className="tips">
      <p className="tips-caution">
        Anonymous and unverified. A tip carries no weight in the score and moves nothing in the
        queue — treat it as something to check, never as a finding.
      </p>

      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}

      <ul className="tip-list">
        {tips.map((tip) => (
          <li key={tip.id} className={`tip-item${tip.markedAbusive ? ' is-abusive' : ''}`}>
            <div className="tip-meta">
              <time dateTime={tip.createdAt}>
                {new Date(tip.createdAt).toLocaleDateString('en-IN', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}
              </time>
              {tip.markedAbusive ? <span className="tip-tag">Marked abusive</span> : null}
            </div>

            {tip.markedAbusive ? (
              <p className="tip-hidden">
                Hidden by a reviewer. The message is retained in the record but is not shown here.
              </p>
            ) : (
              <>
                <p className="tip-body">{tip.body}</p>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy === tip.id}
                  onClick={() => markAbusive(tip.id)}
                >
                  {busy === tip.id ? 'Marking…' : 'Mark abusive'}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
