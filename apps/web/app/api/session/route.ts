import { cookies } from 'next/headers';

import { API_BASE, ROLE_COOKIE, SESSION_COOKIE } from '../../lib/session';

/**
 * Sign in and out.
 *
 * The API issues the token; this handler is what keeps it out of the browser's
 * reach. `httpOnly` so script cannot read it, `sameSite: lax` so another site
 * cannot drive a request with it, and `secure` outside development.
 *
 * Three sign-in paths land here — staff password, applicant magic link, and
 * accepting an invitation — because all three end the same way: an API token
 * that needs storing somewhere safe.
 */

const isProduction = process.env.NODE_ENV === 'production';

type Mode = 'staff' | 'applicant' | 'invite';

const ENDPOINT: Record<Mode, string> = {
  staff: '/auth/staff/login',
  applicant: '/auth/applicant/consume-link',
  invite: '/auth/accept-invite',
};

export async function POST(request: Request) {
  let body: { mode?: Mode } & Record<string, unknown>;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid_request', message: 'Expected JSON.' }, { status: 400 });
  }

  const mode: Mode = body.mode === 'applicant' || body.mode === 'invite' ? body.mode : 'staff';
  const { mode: _ignored, ...payload } = body;

  let upstream: Response;
  try {
    upstream = await fetch(`${API_BASE}${ENDPOINT[mode]}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
  } catch {
    return Response.json(
      { error: 'unreachable', message: 'The API is not responding. Start it with `npm run dev`.' },
      { status: 503 },
    );
  }

  const result = (await upstream.json().catch(() => ({}))) as {
    token?: string;
    role?: string;
    expiresInHours?: number;
    message?: string;
    error?: string;
  };

  if (!upstream.ok || !result.token) {
    return Response.json(
      { error: result.error ?? 'sign_in_failed', message: result.message ?? 'Sign-in failed.' },
      { status: upstream.status === 200 ? 502 : upstream.status },
    );
  }

  const role = mode === 'applicant' ? 'applicant' : (result.role ?? 'reviewer');
  const jar = await cookies();
  // The cookie lives exactly as long as the token inside it. Shorter, and a
  // refresh signs out someone whose token is still good; longer, and the page
  // keeps sending a dead token and reads as signed in when it is not.
  const hours = typeof result.expiresInHours === 'number' && result.expiresInHours > 0 ? result.expiresInHours : 12;
  const options = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isProduction,
    path: '/',
    maxAge: hours * 60 * 60,
  };

  jar.set(SESSION_COOKIE, result.token, options);
  // Readable by the server only as well: the role decides which navigation the
  // layout renders, and the API re-checks it on every call regardless.
  jar.set(ROLE_COOKIE, role, options);

  return Response.json({ role });
}

export async function DELETE() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  jar.delete(ROLE_COOKIE);
  return Response.json({ status: 'signed_out' });
}
