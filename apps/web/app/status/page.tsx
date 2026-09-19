import type { ApplicantApplicationView } from '@scholarshield/shared';

import { apiGet, getSession } from '../lib/session';
import { ConsumeLink } from './ConsumeLink';
import { RequestLinkForm } from './RequestLinkForm';
import { StageList } from './StageList';

/**
 * Where an applicant checks their application.
 *
 * Three states, decided on the server:
 *   - arriving from an emailed link (`?token=`) — exchange it for a session;
 *   - holding an applicant session — list their applications;
 *   - neither — ask for the email the application was filed under.
 *
 * The list comes from /applications/mine, which serializes through
 * toApplicantView. There is no score or flag here to hide: the API never sent one.
 */
export default async function StatusPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await searchParams;

  let body: React.ReactNode;
  if (typeof token === 'string' && token !== '') {
    body = <ConsumeLink token={token} />;
  } else {
    const session = await getSession();
    const mine =
      session?.role === 'applicant' ? await apiGet<ApplicantApplicationView[]>('/applications/mine') : null;

    if (mine?.kind === 'ok') {
      body = <StageList applications={mine.data} />;
    } else {
      // An expired applicant session lands here too, which is the right outcome:
      // the fix for an expired link is a new one.
      body = <RequestLinkForm expired={mine?.kind === 'unauthenticated'} />;
    }
  }

  return (
    <section className="section auth-section">
      <div className="container auth-shell">{body}</div>
    </section>
  );
}
