import { API_BASE, getSession } from '../../../lib/session';

/**
 * How a client component reaches the API.
 *
 * It cannot call the API directly with the session, because the token is in an
 * httpOnly cookie that JavaScript cannot read — which is the point. This
 * forwards the request from the server with the token attached.
 *
 * It is a narrow pipe on purpose: only these methods, only this API, and the
 * path is rebuilt from the route segments rather than taken from a parameter, so
 * there is nothing here to point somewhere else.
 */

const ALLOWED = new Set(['GET', 'POST', 'DELETE']);

async function forward(request: Request, segments: string[]): Promise<Response> {
  if (!ALLOWED.has(request.method)) {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }

  const session = await getSession();
  if (!session) {
    return Response.json(
      { error: 'unauthorized', message: 'Your session has expired. Sign in again.' },
      { status: 401 },
    );
  }

  const search = new URL(request.url).search;
  const target = `${API_BASE}/${segments.map(encodeURIComponent).join('/')}${search}`;

  const headers = new Headers({ Authorization: `Bearer ${session.token}` });
  const contentType = request.headers.get('content-type');
  // Multipart uploads carry a generated boundary in this header, so it has to
  // travel with the body rather than be reconstructed.
  if (contentType) headers.set('Content-Type', contentType);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' ? undefined : await request.arrayBuffer(),
      cache: 'no-store',
    });
  } catch {
    return Response.json(
      { error: 'unreachable', message: 'The API is not responding.' },
      { status: 503 },
    );
  }

  // Streamed back as-is: a CSV export goes through here too, and re-encoding it
  // as JSON would corrupt it.
  const body = await upstream.arrayBuffer();
  const responseHeaders = new Headers();
  for (const header of ['content-type', 'content-disposition']) {
    const value = upstream.headers.get(header);
    if (value) responseHeaders.set(header, value);
  }

  return new Response(body, { status: upstream.status, headers: responseHeaders });
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await context.params).path);
}

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await context.params).path);
}

export async function DELETE(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await context.params).path);
}
