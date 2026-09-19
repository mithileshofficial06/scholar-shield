'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';

import { ArrowIcon, UsersIcon } from '../components/Icons';

const MIN_PASSWORD = 12;

/**
 * Accept a reviewer invitation and set a password.
 *
 * The emailed token is the credential; it goes to this origin's session route,
 * which exchanges it with the API and keeps the resulting session in an httpOnly
 * cookie, exactly as a password sign-in does. The length rule mirrors the API's,
 * which remains the one that is enforced.
 */
function AcceptInviteForm() {
  const router = useRouter();
  const token = useSearchParams().get('token');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!token) {
    return (
      <div className="card auth-card">
        <span className="auth-icon">
          <UsersIcon />
        </span>
        <h1>Invitation link incomplete</h1>
        <p className="auth-lede">
          This page needs the full link from your invitation email. Open it from the email again,
          or ask an administrator to send a new invitation.
        </p>
      </div>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const data = new FormData(event.currentTarget);
    const password = String(data.get('password') ?? '');
    if (password !== String(data.get('confirm') ?? '')) {
      setError('The two passwords do not match.');
      return;
    }

    setBusy(true);
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'invite', token, password }),
    }).catch(() => null);

    if (!res?.ok) {
      const body = (await res?.json().catch(() => ({}))) as { message?: string } | undefined;
      setError(body?.message ?? 'Could not accept the invitation.');
      setBusy(false);
      return;
    }

    router.refresh();
    router.push('/dashboard');
  }

  return (
    <form className="card auth-card" onSubmit={onSubmit}>
      <span className="auth-icon">
        <UsersIcon />
      </span>
      <h1>Accept your invitation</h1>
      <p className="auth-lede">
        Set a password to finish creating your reviewer account. Every decision you make will need
        a written reason and is recorded in an append-only audit log.
      </p>

      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="field">
        <label className="field-label" htmlFor="password">
          New password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          className="input"
          autoComplete="new-password"
          minLength={MIN_PASSWORD}
          maxLength={200}
          aria-describedby="password-hint"
          required
          autoFocus
        />
        <span className="field-hint" id="password-hint">
          At least {MIN_PASSWORD} characters. Length matters more than symbols.
        </span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="confirm">
          Confirm password
        </label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          className="input"
          autoComplete="new-password"
          minLength={MIN_PASSWORD}
          maxLength={200}
          required
        />
      </div>

      <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
        {busy ? 'Setting up…' : 'Set password and continue'}
        {busy ? null : <ArrowIcon />}
      </button>

      <p className="auth-foot">
        Already set up? <Link href="/login">Sign in</Link>.
      </p>
    </form>
  );
}

export default function AcceptInvitePage() {
  return (
    <section className="section auth-section">
      <div className="container auth-shell">
        <Suspense fallback={<div className="card auth-card">Loading…</div>}>
          <AcceptInviteForm />
        </Suspense>
      </div>
    </section>
  );
}
