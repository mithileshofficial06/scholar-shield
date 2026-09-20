import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getSession } from '../lib/session';
import { SecurityPanel } from './SecurityPanel';

export const metadata: Metadata = {
  title: 'Security · ScholarShield',
};

/**
 * A staff account's own security settings.
 *
 * Separate from /admin because two-factor is a property of the person signed in,
 * not something an administrator configures for someone else — an admin who
 * could enrol a factor on another account could also enrol one they control.
 */
export default async function SecurityPage() {
  const session = await getSession();
  if (session?.role !== 'reviewer' && session?.role !== 'admin') {
    redirect('/login?next=/security');
  }

  return (
    <section className="section auth-section">
      <div className="container auth-shell security-shell">
        <header className="tip-head">
          <h1>Security</h1>
          <p className="tip-lede">
            Two-factor authentication for your account. Reviewers can read every application in the
            queue, which is what makes this worth the extra step.
          </p>
        </header>

        <SecurityPanel />
      </div>
    </section>
  );
}
