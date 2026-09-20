'use client';

import { useState, type FormEvent } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * The anonymous tip form.
 *
 * Posts straight to the API rather than through /api/proxy, because the proxy
 * attaches a session and refuses without one — and this form must work for
 * someone who has never signed in and never will.
 *
 * There is no name field, no email field and no "we may contact you". Adding one
 * later would change what the page promises, so the promise is kept narrow:
 * nothing identifying is collected, and the confirmation says plainly that no
 * one will get back to you.
 */
export function TipForm() {
  const [body, setBody] = useState('');
  const [applicationId, setApplicationId] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    let res: Response;
    try {
      res = await fetch(`${API_URL}/tips`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body,
          applicationId: applicationId.trim() === '' ? undefined : applicationId.trim(),
        }),
      });
    } catch {
      setError('Could not reach the service. Check your connection and try again.');
      setBusy(false);
      return;
    }

    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { message?: string };
      setError(payload.message ?? 'That could not be sent.');
      setBusy(false);
      return;
    }

    setBusy(false);
    setSent(true);
  }

  if (sent) {
    return (
      <div className="card tip-done">
        <h2>Thank you.</h2>
        <p>
          A reviewer will see this alongside the application it concerns. Nobody will contact you,
          and nothing you submitted identifies you.
        </p>
        <p className="tip-note">
          A tip does not by itself flag an application or move it up the queue. It is one more thing
          a person reads before they decide.
        </p>
      </div>
    );
  }

  return (
    <form className="card tip-form" onSubmit={onSubmit}>
      <div className="field">
        <label className="field-label" htmlFor="body">
          What did you see? <span className="field-required">*</span>
        </label>
        <textarea
          id="body"
          className="input textarea"
          rows={6}
          minLength={10}
          maxLength={2000}
          required
          placeholder="Describe what you know. Be specific about what you saw rather than who you think someone is."
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <span className="field-hint">Between 10 and 2000 characters.</span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="applicationId">
          Application reference <span className="field-optional">optional</span>
        </label>
        <input
          id="applicationId"
          className="input"
          placeholder="If you have one. Leave blank if you do not."
          value={applicationId}
          onChange={(event) => setApplicationId(event.target.value)}
        />
        <span className="field-hint">
          You do not need this. A tip without a reference still reaches a reviewer.
        </span>
      </div>

      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}

      <button type="submit" className="btn btn-primary" disabled={busy || body.trim().length < 10}>
        {busy ? 'Sending…' : 'Send anonymously'}
      </button>
    </form>
  );
}
