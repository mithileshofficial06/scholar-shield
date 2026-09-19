'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { ArrowIcon, MessageIcon } from '../components/Icons';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * Ask for a sign-in link.
 *
 * Posts to the API directly, for the same reason the apply form does: the
 * endpoint is public and its rate limit is per address. The reply is the same
 * whether or not the email has an application, so this cannot be used to find
 * out who applied.
 *
 * With no mail server configured (the local stack), the API returns the token
 * outside production so the flow can still be walked end to end. It is offered
 * here as a link, labelled for what it is.
 */
export function RequestLinkForm({ expired }: { expired: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ message: string; devToken?: string } | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const data = new FormData(event.currentTarget);
    const res = await fetch(`${API_URL}/auth/applicant/request-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: String(data.get('email') ?? ''),
        fullName: String(data.get('fullName') ?? ''),
      }),
    }).catch(() => null);

    const body = (await res?.json().catch(() => ({}))) as
      | { message?: string; devToken?: string }
      | undefined;

    if (!res?.ok) {
      setError(body?.message ?? 'The application service is not responding. Try again shortly.');
      setBusy(false);
      return;
    }

    setSent({ message: body?.message ?? 'Check your email for a sign-in link.', devToken: body?.devToken });
    setBusy(false);
  }

  if (sent) {
    return (
      <div className="card auth-card">
        <span className="auth-icon">
          <MessageIcon />
        </span>
        <h1>Check your email</h1>
        <p className="auth-lede">{sent.message} It works once and expires shortly.</p>
        {sent.devToken ? (
          <p className="auth-note">
            Local demo: no mail server is configured, so the link was written to the API log
            instead of sent.{' '}
            <Link href={`/status?token=${encodeURIComponent(sent.devToken)}`}>Open the sign-in link</Link>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form className="card auth-card" onSubmit={onSubmit}>
      <span className="auth-icon">
        <MessageIcon />
      </span>
      <h1>Check your application</h1>
      <p className="auth-lede">
        Enter the email you applied with and we&rsquo;ll send a one-time sign-in link.
      </p>

      {expired ? (
        <p className="auth-note" role="status">
          Your session has ended. Request a new link to continue.
        </p>
      ) : null}
      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="field">
        <label className="field-label" htmlFor="email">
          Email
        </label>
        <input id="email" name="email" type="email" className="input" autoComplete="email" required autoFocus />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="fullName">
          Full name
        </label>
        <input
          id="fullName"
          name="fullName"
          className="input"
          autoComplete="name"
          minLength={2}
          maxLength={120}
          required
        />
      </div>

      <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
        {busy ? 'Sending…' : 'Send sign-in link'}
        {busy ? null : <ArrowIcon />}
      </button>

      <p className="auth-foot">
        Haven&rsquo;t applied yet? <Link href="/apply">Start an application</Link>.
      </p>
    </form>
  );
}
