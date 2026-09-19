'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Sign in / sign out in the masthead.
 *
 * The role comes from the server layout, which reads the session cookie. It
 * only decides what this renders — every API call re-checks the role, so a
 * tampered cookie changes the menu and nothing else.
 */
export function SessionControls({ role }: { role: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!role) {
    return (
      <Link href="/login" className="btn btn-ghost btn-sm">
        Staff sign in
      </Link>
    );
  }

  async function signOut() {
    setBusy(true);
    await fetch('/api/session', { method: 'DELETE' });
    router.refresh();
    router.push('/');
  }

  return (
    <div className="session-controls">
      <span className="role-pill" title={`Signed in as ${role}`}>
        {role}
      </span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={signOut} disabled={busy}>
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
