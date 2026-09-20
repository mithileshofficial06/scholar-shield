'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';

import { ArrowIcon, LockIcon } from '../components/Icons';

/**
 * Reviewer sign-in.
 *
 * Posts to this origin's session route, which exchanges the credentials with
 * the API and keeps the token in an httpOnly cookie — the browser never holds
 * it. The failure message is the API's own, which is deliberately identical for
 * an unknown address and a wrong password.
 */
function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Revealed only once the API says this account has an authenticator. Showing
  // the field to everyone would tell an attacker which accounts have a second
  // factor before they have got the password right.
  const [needsCode, setNeedsCode] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const data = new FormData(event.currentTarget);
    const code = String(data.get('totpCode') ?? '').trim();
    const recovery = String(data.get('recoveryCode') ?? '').trim();

    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'staff',
        email: String(data.get('email') ?? ''),
        password: String(data.get('password') ?? ''),
        ...(code === '' ? {} : { totpCode: code }),
        ...(recovery === '' ? {} : { recoveryCode: recovery }),
      }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (body.error === 'totp_required') {
        // First step of a two-step sign-in, not a failure. The password was
        // right; saying "Sign-in failed" here would be a lie that sends people
        // to reset a password that works.
        setNeedsCode(true);
        setError(null);
      } else {
        setError(body.message ?? 'Sign-in failed.');
      }
      setBusy(false);
      return;
    }

    // refresh() so server components pick up the new cookie before navigating.
    router.refresh();
    router.push(next && next.startsWith('/') ? next : '/dashboard');
  }

  return (
    <form className="card auth-card" onSubmit={onSubmit}>
      <span className="auth-icon">
        <LockIcon />
      </span>
      <h1>Reviewer sign-in</h1>
      <p className="auth-lede">
        Invite-only. Reviewers see risk signals and decide; the system never decides for them.
      </p>

      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="field">
        <label className="field-label" htmlFor="email">
          Work email
        </label>
        <input id="email" name="email" type="email" className="input" autoComplete="username" required autoFocus />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          className="input"
          autoComplete="current-password"
          required
        />
      </div>

      {needsCode ? (
        <div className="field">
          <label className="field-label" htmlFor={useRecovery ? 'recoveryCode' : 'totpCode'}>
            {useRecovery ? 'Recovery code' : 'Six-digit code'}
          </label>
          {useRecovery ? (
            <input
              id="recoveryCode"
              name="recoveryCode"
              className="input"
              autoComplete="one-time-code"
              placeholder="XXXXX-XXXXX"
              required
              autoFocus
            />
          ) : (
            <input
              id="totpCode"
              name="totpCode"
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9\s]*"
              placeholder="000000"
              required
              autoFocus
            />
          )}
          <span className="field-hint">
            {useRecovery
              ? 'One of the codes you saved when you set up the authenticator. Each works once.'
              : 'From your authenticator app.'}{' '}
            <button
              type="button"
              className="auth-link-button"
              onClick={() => setUseRecovery((previous) => !previous)}
            >
              {useRecovery ? 'Use the app instead' : 'Lost your phone?'}
            </button>
          </span>
        </div>
      ) : null}

      <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
        {busy ? 'Signing in…' : needsCode ? 'Verify and sign in' : 'Sign in'}
        {busy ? null : <ArrowIcon />}
      </button>

      <p className="auth-foot">
        Applicants don&rsquo;t sign in here — <Link href="/status">check an application</Link> with a
        link sent to your email.
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <section className="section auth-section">
      <div className="container auth-shell">
        <Suspense fallback={<div className="card auth-card">Loading…</div>}>
          <SignInForm />
        </Suspense>
      </div>
    </section>
  );
}
