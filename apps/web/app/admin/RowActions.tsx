'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** A one-click action on a row: post, then re-render the server page. */
function useRowAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(url: string, init: RequestInit) {
    setBusy(true);
    setError(null);
    const res = await fetch(url, init).catch(() => null);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => ({}))) as { message?: string } | undefined;
      setError(body?.message ?? 'That did not work. Try again.');
      setBusy(false);
      return;
    }
    router.refresh();
  }

  return { busy, error, run };
}

/** Clear a dead-lettered stage and put the document back on the queue. */
export function RetryButton({ documentId, stage }: { documentId: string; stage: string }) {
  const { busy, error, run } = useRowAction();
  return (
    <div className="row-action">
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={busy}
        onClick={() =>
          run('/api/proxy/pipeline/retry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ documentId, stage }),
          })
        }
      >
        {busy ? 'Queuing…' : 'Retry'}
      </button>
      {error ? <p className="row-action-error" role="alert">{error}</p> : null}
    </div>
  );
}

/** Remove a reviewer's access, or restore it. Deactivation ends their sessions at once. */
export function StaffAccessButton({ userId, deactivated }: { userId: string; deactivated: boolean }) {
  const { busy, error, run } = useRowAction();
  return (
    <div className="row-action">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={busy}
        onClick={() => {
          if (deactivated) {
            void run(`/api/proxy/admin/users/${userId}/reactivate`, { method: 'POST' });
          } else if (
            window.confirm('Deactivate this account? They are signed out everywhere immediately and cannot sign in again.')
          ) {
            void run(`/api/proxy/admin/users/${userId}/deactivate`, { method: 'POST' });
          }
        }}
      >
        {busy ? 'Saving…' : deactivated ? 'Reactivate' : 'Deactivate'}
      </button>
      {error ? <p className="row-action-error" role="alert">{error}</p> : null}
    </div>
  );
}

/** Withdraw an invitation nobody has accepted yet. */
export function WithdrawInviteButton({ userId }: { userId: string }) {
  const { busy, error, run } = useRowAction();
  return (
    <div className="row-action">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={busy}
        onClick={() => {
          if (window.confirm('Withdraw this invitation? The link in their email will stop working.')) {
            void run(`/api/proxy/admin/users/${userId}/invite`, { method: 'DELETE' });
          }
        }}
      >
        {busy ? 'Withdrawing…' : 'Withdraw invite'}
      </button>
      {error ? <p className="row-action-error" role="alert">{error}</p> : null}
    </div>
  );
}
