import type { ApplicantApplicationView } from '@scholarshield/shared';

import { apiGet, getSession } from '../lib/session';
import { ApplyForm } from './ApplyForm';

/**
 * The form itself is a client component; this server wrapper exists to ask one
 * question first, with the httpOnly session the browser cannot read: has this
 * signed-in applicant already applied? If so they are shown that application
 * rather than a blank form, which is what used to invite a second submission.
 */
export default async function ApplyPage() {
  const session = await getSession();
  const mine =
    session?.role === 'applicant' ? await apiGet<ApplicantApplicationView[]>('/applications/mine') : null;

  return <ApplyForm existing={mine?.kind === 'ok' ? mine.data : []} />;
}
