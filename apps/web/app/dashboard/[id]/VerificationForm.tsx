'use client';

import type { VerificationResult, VerificationStatus } from '@scholarshield/shared';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { ArrowIcon } from '../../components/Icons';

type Recordable = Exclude<VerificationStatus, 'manual_check_required'>;

const OPTIONS: { value: Recordable; label: string; hint: string; tone: string }[] = [
  { value: 'verified', label: 'Matches', hint: 'The portal shows this certificate with the same details.', tone: 'low' },
  { value: 'mismatch', label: 'Does not match', hint: 'Not found, or different details. Say what differed.', tone: 'high' },
  { value: 'unavailable', label: 'Portal unavailable', hint: 'Could not check. Try again later.', tone: 'medium' },
];

const TONE: Record<VerificationStatus, string> = {
  manual_check_required: 'sev-medium',
  verified: 'sev-low',
  mismatch: 'sev-high',
  unavailable: 'sev-medium',
};

/**
 * Check the certificate on the state portal, then record what it said.
 *
 * ScholarShield never contacts the portal itself; the link is pre-filled and a
 * person reads the result. Recording it is what lets the checklist show the
 * government-record check as passed or failed instead of pending forever — and
 * a mismatch raises the application in the queue, so it must say why.
 */
export function VerificationForm({
  applicationId,
  verification,
}: {
  applicationId: string;
  verification: VerificationResult | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Recordable>('verified');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!verification) {
    return <p className="verify-note">No verification link yet — the certificate has not been processed.</p>;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const res = await fetch(`/api/proxy/applications/${applicationId}/verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, notes: notes.trim() || undefined }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setError(body.message ?? 'Could not record the result.');
      setBusy(false);
      return;
    }

    setNotes('');
    setBusy(false);
    router.refresh();
  }

  return (
    <>
      <p className="verify-status">
        <span className={`sev-pill ${TONE[verification.status]}`}>{verification.status.replaceAll('_', ' ')}</span>
        {verification.checkedAt ? (
          <span className="verify-when">recorded {new Date(verification.checkedAt).toLocaleString('en-IN')}</span>
        ) : null}
      </p>
      {verification.notes ? <p className="verify-recorded">“{verification.notes}”</p> : null}

      <a className="btn btn-ghost btn-sm" href={verification.manualCheckUrl} target="_blank" rel="noreferrer">
        Open state portal
        <ArrowIcon />
      </a>

      <form className="verify-form" onSubmit={onSubmit}>
        <fieldset className="decision-options">
          <legend className="field-label">What did the portal show?</legend>
          {OPTIONS.map((option) => (
            <label
              key={option.value}
              className={`decision-option sev-${option.tone}${status === option.value ? ' is-selected' : ''}`}
            >
              <input
                type="radio"
                name="verification"
                value={option.value}
                checked={status === option.value}
                onChange={() => setStatus(option.value)}
                className="visually-hidden"
              />
              <span className="decision-label">{option.label}</span>
              <span className="decision-hint">{option.hint}</span>
            </label>
          ))}
        </fieldset>

        <div className="field">
          <label className="field-label" htmlFor="verify-notes">
            Notes{status === 'mismatch' ? <span className="field-required"> *</span> : ' (optional)'}
          </label>
          <textarea
            id="verify-notes"
            className="input textarea"
            rows={3}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder={status === 'mismatch' ? 'e.g. Portal shows income ₹4,80,000 for this number' : ''}
            required={status === 'mismatch'}
            minLength={status === 'mismatch' ? 12 : undefined}
            maxLength={2000}
          />
        </div>

        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Recording…' : 'Record result'}
        </button>
      </form>
    </>
  );
}
