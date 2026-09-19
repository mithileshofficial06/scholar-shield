'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

/**
 * Invite a reviewer or an admin.
 *
 * The invitee sets their own password from the emailed link; nobody here ever
 * types one for them. With no mail server configured (the local stack) the API
 * returns the link outside production, and it is offered as such.
 */
export function InviteForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ email: string; devToken?: string } | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    setSent(null);

    const email = String(data.get('email') ?? '');
    const res = await fetch('/api/proxy/admin/users/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role: String(data.get('role') ?? 'reviewer') }),
    }).catch(() => null);

    const body = (await res?.json().catch(() => ({}))) as { message?: string; devToken?: string } | undefined;
    setBusy(false);
    if (!res?.ok) {
      setError(body?.message ?? 'The invitation could not be sent.');
      return;
    }
    form.reset();
    setSent({ email, devToken: body?.devToken });
    router.refresh();
  }

  return (
    <form className="inline-form" onSubmit={onSubmit}>
      <div className="field">
        <label className="field-label" htmlFor="invite-email">
          Email
        </label>
        <input id="invite-email" name="email" type="email" className="input" required placeholder="name@college.edu" />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="invite-role">
          Role
        </label>
        <select id="invite-role" name="role" className="input select" defaultValue="reviewer">
          <option value="reviewer">Reviewer — reviews and decides</option>
          <option value="admin">Admin — also manages staff and imports</option>
        </select>
      </div>
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? 'Sending…' : 'Send invitation'}
      </button>

      {error ? (
        <p className="auth-error inline-form-full" role="alert">
          {error}
        </p>
      ) : null}
      {sent ? (
        <p className="auth-note inline-form-full" role="status">
          Invitation sent to {sent.email}.
          {sent.devToken ? (
            <>
              {' '}
              No mail server is configured, so here is their link:{' '}
              <Link href={`/accept-invite?token=${encodeURIComponent(sent.devToken)}`}>accept-invite link</Link>
            </>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}
