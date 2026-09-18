'use client';

import type { ApplicationStatus, ReviewDecision } from '@scholarshield/shared';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

const OPTIONS: { value: ReviewDecision; label: string; hint: string; tone: string }[] = [
  { value: 'approve', label: 'Approve', hint: 'Award the scholarship.', tone: 'low' },
  { value: 'escalate', label: 'Escalate', hint: 'Send to a senior reviewer. Not a decision.', tone: 'medium' },
  { value: 'reject', label: 'Reject', hint: 'Refuse the application.', tone: 'high' },
];

/**
 * The reviewer's decision.
 *
 * Nothing about the score is repeated here on purpose. The score decided when
 * this application was looked at; it has no part in what is decided, and a
 * number sitting next to the buttons would invite exactly that.
 *
 * A written reason is mandatory — the API and the database both refuse without
 * one — because the reason is what the applicant is owed if they ever ask why.
 */
export function DecisionForm({
  applicationId,
  status,
}: {
  applicationId: string;
  status: ApplicationStatus;
}) {
  const router = useRouter();
  const [decision, setDecision] = useState<ReviewDecision>('approve');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const settled = status === 'approved' || status === 'rejected';

  if (settled) {
    return (
      <div className="panel-empty">
        <p>
          This application was <strong>{status}</strong>. Decisions are append-only — reopening it
          would mean a new application, not an edit to this one.
        </p>
      </div>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const res = await fetch(`/api/proxy/applications/${applicationId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, reason }),
    });

    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { message?: string };
      setError(payload.message ?? 'That decision could not be recorded.');
      setBusy(false);
      return;
    }

    setBusy(false);
    setReason('');
    router.refresh();
  }

  return (
    <form className="decision" onSubmit={onSubmit}>
      <fieldset className="decision-options">
        <legend className="visually-hidden">Decision</legend>
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className={`decision-option sev-${option.tone}${decision === option.value ? ' is-selected' : ''}`}
          >
            <input
              type="radio"
              name="decision"
              value={option.value}
              checked={decision === option.value}
              onChange={() => setDecision(option.value)}
              className="visually-hidden"
            />
            <span className="decision-label">{option.label}</span>
            <span className="decision-hint">{option.hint}</span>
          </label>
        ))}
      </fieldset>

      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="field">
        <label className="field-label" htmlFor="reason">
          Reason <span className="field-required">*</span>
        </label>
        <textarea
          id="reason"
          className="input textarea"
          rows={3}
          minLength={12}
          required
          placeholder="What did you check, and what did you conclude? The applicant is owed this."
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <span className="field-hint">
          Recorded with your name in an append-only audit log. At least 12 characters.
        </span>
      </div>

      <button type="submit" className="btn btn-primary" disabled={busy || reason.trim().length < 12}>
        {busy ? 'Recording…' : `Record ${decision}`}
      </button>
    </form>
  );
}
