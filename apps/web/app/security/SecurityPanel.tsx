'use client';

import { useEffect, useState } from 'react';

interface Status {
  enabled: boolean;
  pending: boolean;
  recoveryCodesRemaining: number;
}

/**
 * Two-factor enrolment for a staff account.
 *
 * NO QR CODE, DELIBERATELY
 * ------------------------
 * Rendering one means a QR dependency in the web bundle for a page most people
 * visit once. The `otpauth://` link opens the authenticator directly on a phone,
 * and the secret is shown grouped for manual entry on a desktop — which is the
 * path anyone scanning from a second device takes anyway. If this page starts
 * getting used from a desktop with a phone in hand, a QR earns its place; until
 * then it does not.
 *
 * The recovery codes are rendered once, from the response that created them, and
 * are never fetched again because the server kept only their hashes.
 */
export function SecurityPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadStatus() {
    const res = await fetch('/api/proxy/auth/totp/status');
    if (res.ok) setStatus((await res.json()) as Status);
  }

  useEffect(() => {
    void loadStatus();
  }, []);

  async function post(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/proxy/auth/totp/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    setBusy(false);
    if (!res.ok) {
      setError((payload.message as string) ?? 'That did not work.');
      return null;
    }
    return payload;
  }

  async function begin() {
    const payload = await post('enrol');
    if (!payload) return;
    setSecret(payload.secret as string);
    setUri(payload.otpauthUri as string);
    setCodes(null);
  }

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const payload = await post('confirm', { code: String(data.get('code') ?? '') });
    if (!payload) return;
    setCodes(payload.recoveryCodes as string[]);
    setSecret(null);
    setUri(null);
    await loadStatus();
  }

  async function disable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const code = String(data.get('code') ?? '').trim();
    const payload = await post('disable', /^\d{6}$/.test(code.replace(/\s/g, ''))
      ? { code }
      : { recoveryCode: code });
    if (!payload) return;
    setCodes(null);
    await loadStatus();
  }

  if (!status) return <div className="panel-empty"><p>Loading…</p></div>;

  return (
    <div className="security">
      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}

      {codes ? (
        <div className="card recovery-codes">
          <h2>Save these recovery codes</h2>
          <p>
            Each one signs you in once if you lose your authenticator. They are not stored in a form
            anyone can read back to you, so this is the only time they are shown.
          </p>
          <ul>
            {codes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCodes(null)}>
            I have saved them
          </button>
        </div>
      ) : null}

      {status.enabled ? (
        <div className="card">
          <h2>Two-factor is on</h2>
          <p className="security-note">
            {status.recoveryCodesRemaining} recovery code
            {status.recoveryCodesRemaining === 1 ? '' : 's'} left. Turning two-factor off and back on
            issues a fresh set.
          </p>
          <form className="security-form" onSubmit={disable}>
            <div className="field">
              <label className="field-label" htmlFor="disable-code">
                Current code, to turn it off
              </label>
              <input
                id="disable-code"
                name="code"
                className="input"
                autoComplete="one-time-code"
                placeholder="000000 or a recovery code"
                required
              />
              <span className="field-hint">
                Required even though you are signed in: a stolen session should not be able to
                strip the thing that would have stopped it.
              </span>
            </div>
            <button type="submit" className="btn btn-ghost" disabled={busy}>
              {busy ? 'Working…' : 'Turn off two-factor'}
            </button>
          </form>
        </div>
      ) : secret && uri ? (
        <div className="card">
          <h2>Add it to your authenticator</h2>
          <p className="security-note">
            On this phone, <a href={uri}>open your authenticator app</a>. On a desktop, type this
            key into the app by hand:
          </p>
          <p className="security-secret">{secret.match(/.{1,4}/g)?.join(' ')}</p>
          <form className="security-form" onSubmit={confirm}>
            <div className="field">
              <label className="field-label" htmlFor="code">
                Then enter the six-digit code it shows
              </label>
              <input
                id="code"
                name="code"
                className="input"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                required
                autoFocus
              />
              <span className="field-hint">
                Two-factor is not on until this succeeds, so a half-finished setup cannot lock you
                out.
              </span>
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Checking…' : 'Turn on two-factor'}
            </button>
          </form>
        </div>
      ) : (
        <div className="card">
          <h2>Two-factor is off</h2>
          <p className="security-note">
            A password alone is one leaked reused credential away from someone else reading every
            application in the queue. An authenticator app adds a code that changes every 30 seconds.
          </p>
          <button type="button" className="btn btn-primary" onClick={begin} disabled={busy}>
            {busy ? 'Starting…' : status.pending ? 'Start again' : 'Set up two-factor'}
          </button>
        </div>
      )}
    </div>
  );
}
