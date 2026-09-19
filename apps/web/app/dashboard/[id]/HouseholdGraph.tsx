'use client';

import type { HouseholdView } from '@scholarshield/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The household the resolver inferred, and the matches that built it.
 *
 * Entity resolution produces false merges, so every edge is shown with the
 * field it matched on and its similarity, and every edge can be rejected. The
 * rejection is the point of the picture: a reviewer who can see why two
 * applications were joined is the mechanism by which a wrong join gets undone.
 */
export function HouseholdGraph({ view, applicationId }: { view: HouseholdView; applicationId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const members = view.members;
  const byId = new Map(members.map((m) => [m.id, m]));
  const incomes = members.map((m) => m.declaredAnnualIncome);
  const spread = members.length > 1 ? Math.max(...incomes) - Math.min(...incomes) : 0;

  async function act(edgeId: string, action: 'reject' | 'restore', body?: { reason: string }) {
    setBusy(edgeId);
    setError(null);
    const res = await fetch(`/api/proxy/households/edges/${edgeId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { message?: string };
      setError(payload.message ?? 'That change could not be applied.');
      setBusy(null);
      return;
    }
    setRejecting(null);
    setReason('');
    setBusy(null);
    // The whole cycle was re-resolved and re-scored, so refresh rather than
    // patch: this application's flags and score may both have changed.
    router.refresh();
  }

  if (members.length <= 1) {
    return (
      <div className="panel-empty">
        <p>
          <strong>No household resolved.</strong> Nothing in this cycle matched closely enough to
          join this application to another, so no household rule can fire on it.
        </p>
      </div>
    );
  }

  return (
    <div className="household">
      <div className="household-summary">
        <span>
          <strong>{members.length}</strong> applications resolved into one household
        </span>
        {spread > 0 ? (
          <span className={spread > 12000 ? 'sev-high' : ''}>
            Declared income spread <strong className="tabular">₹{spread.toLocaleString('en-IN')}</strong>
          </span>
        ) : null}
      </div>

      <ul className="member-list">
        {members.map((member) => (
          <li key={member.id} className={`member${member.id === applicationId ? ' is-current' : ''}`}>
            <div>
              <p className="member-name">
                {member.applicantName}
                {member.id === applicationId ? <span className="member-tag">this application</span> : null}
              </p>
              <p className="member-meta">
                Guardian {member.guardianName} · {member.district} · family of {member.declaredFamilySize}
              </p>
            </div>
            <div className="member-figures">
              <span className="member-income tabular">₹{member.declaredAnnualIncome.toLocaleString('en-IN')}</span>
              <span className="member-score tabular">score {member.riskScore.toFixed(0)}</span>
            </div>
          </li>
        ))}
      </ul>

      <p className="household-edges-title">Matches that built this household</p>
      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}

      <ul className="edge-list">
        {view.edges.map((edge) => {
          const a = byId.get(edge.applicationAId);
          const b = byId.get(edge.applicationBId);
          const rejected = edge.rejectedAt !== null;
          return (
            <li key={edge.id} className={`edge${rejected ? ' is-rejected' : ''}`}>
              <div className="edge-body">
                <p className="edge-pair">
                  {a?.applicantName ?? 'Unknown'} ↔ {b?.applicantName ?? 'Unknown'}
                </p>
                <p className="edge-meta">
                  matched on <strong>{edge.matchField.replaceAll('_', ' ')}</strong> · similarity{' '}
                  <span className="tabular">{edge.similarity.toFixed(2)}</span>
                  {rejected ? <span className="edge-rejected"> · rejected: {edge.rejectedReason}</span> : null}
                </p>
              </div>

              {rejected ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy === edge.id}
                  onClick={() => act(edge.id, 'restore')}
                >
                  {busy === edge.id ? 'Restoring…' : 'Restore match'}
                </button>
              ) : rejecting === edge.id ? (
                <form
                  className="edge-reject-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    act(edge.id, 'reject', { reason });
                  }}
                >
                  <input
                    className="input"
                    placeholder="Why is this match wrong?"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    minLength={8}
                    required
                    autoFocus
                  />
                  <button type="submit" className="btn btn-primary btn-sm" disabled={busy === edge.id}>
                    {busy === edge.id ? 'Saving…' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setRejecting(null);
                      setReason('');
                    }}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRejecting(edge.id)}>
                  Not the same household
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <p className="household-note">
        Rejecting every match between two applications splits them apart and re-scores the whole
        cycle, so any contradiction that depended on the merge disappears with it.
      </p>
    </div>
  );
}
