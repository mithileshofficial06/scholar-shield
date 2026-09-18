import { cookies } from 'next/headers';

/**
 * The browser never holds the API token.
 *
 * Sign-in goes to a route handler on this origin, which exchanges credentials
 * with the API and stores the token in an httpOnly cookie. Server components
 * read it here and attach it to their own fetches; client components call the
 * proxy route, which does the same. So the token is never in JavaScript reach,
 * and an XSS bug cannot read it out of localStorage — because it was never put
 * there.
 */

export const SESSION_COOKIE = 'ss_session';
export const ROLE_COOKIE = 'ss_role';

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface Session {
  token: string;
  role: 'reviewer' | 'admin' | 'applicant';
}

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const role = jar.get(ROLE_COOKIE)?.value;
  if (role !== 'reviewer' && role !== 'admin' && role !== 'applicant') return null;
  return { token, role };
}

export type ApiResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' }
  | { kind: 'unreachable' }
  | { kind: 'error'; status: number; message?: string };

/**
 * Fetch from the API as the signed-in user.
 *
 * Returns a tagged result rather than throwing, because every one of these
 * states has a different thing to tell the person looking at the page: sign in,
 * you lack the role, the API is down, or the API said no.
 */
export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  const session = await getSession();
  if (!session) return { kind: 'unauthenticated' };

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${session.token}` },
      cache: 'no-store',
    });

    if (res.status === 401) return { kind: 'unauthenticated' };
    if (res.status === 403) return { kind: 'forbidden' };
    if (!res.ok) {
      const message = await res
        .json()
        .then((body: { message?: string }) => body.message)
        .catch(() => undefined);
      return { kind: 'error', status: res.status, message };
    }

    return { kind: 'ok', data: (await res.json()) as T };
  } catch {
    return { kind: 'unreachable' };
  }
}
