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

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const data = new FormData(event.currentTarget);
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'staff',
        email: String(data.get('email') ?? ''),
        password: String(data.get('password') ?? ''),
      }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setError(body.message ?? 'Sign-in failed.');
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

      <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
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
