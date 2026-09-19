'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { LinkIcon } from '../components/Icons';

/**
 * Exchange an emailed sign-in token for a session.
 *
 * The token is single-use, so the exchange must happen exactly once. Strict mode
 * runs effects twice in development, and the second run would find the token
 * already consumed and report a failure over a sign-in that succeeded — hence
 * the ref guard. The URL is replaced afterwards so the token does not sit
 * in history or get shared by copying the address bar.
 */
export function ConsumeLink({ token }: { token: string }) {
  const router = useRouter();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    (async () => {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'applicant', token }),
      }).catch(() => null);

      if (!res?.ok) {
        const body = (await res?.json().catch(() => ({}))) as { message?: string } | undefined;
        setError(body?.message ?? 'Sign-in failed. Request a new link.');
        return;
      }

      router.replace('/status');
      router.refresh();
    })();
  }, [router, token]);

  return (
    <div className="card auth-card">
      <span className="auth-icon">
        <LinkIcon />
      </span>
      <h1>{error ? 'Link not accepted' : 'Signing you in…'}</h1>
      {error ? (
        <>
          <p className="auth-error" role="alert">
            {error}
          </p>
          <p className="auth-lede">Links expire and work once. Ask for a fresh one below.</p>
          <Link href="/status" className="btn btn-primary auth-submit">
            Request a new link
          </Link>
        </>
      ) : (
        <p className="auth-lede">Checking your sign-in link.</p>
      )}
    </div>
  );
}
