import type { Metadata } from 'next';

import { TipForm } from './TipForm';

export const metadata: Metadata = {
  title: 'Report a concern · ScholarShield',
  description: 'Tell a reviewer about a scholarship application, anonymously.',
};

/**
 * The anonymous tip line.
 *
 * The page spends more words on what a tip CANNOT do than on how to send one,
 * deliberately. A box that accepts accusations about named people has to say
 * out loud that it is not a lever — otherwise its users reasonably assume it is,
 * and the ones it is used against never find out it was pulled.
 */
export default function TipPage() {
  return (
    <section className="section auth-section">
      <div className="container auth-shell tip-shell">
        <header className="tip-head">
          <h1>Report a concern</h1>
          <p className="tip-lede">
            If you know something about a scholarship application that a reviewer should see, tell
            them here. You do not need an account and you will not be asked who you are.
          </p>
        </header>

        <div className="card tip-limits">
          <h2>What happens to this</h2>
          <ul>
            <li>
              <strong>A person reads it.</strong> It appears on the application it concerns, for the
              reviewer handling that file.
            </li>
            <li>
              <strong>It does not flag anyone.</strong> A tip writes no risk flag, changes no score
              and moves nothing up the queue. Nothing here decides an outcome — a reviewer does,
              with a written reason.
            </li>
            <li>
              <strong>We do not keep who you are.</strong> No name, no email, no account. Your
              network address is hashed for rate limiting before it is stored and the original is
              never kept.
            </li>
            <li>
              <strong>Reviewers can mark a tip abusive.</strong> It then stops being shown. It is not
              deleted, because a message used to harass someone is the record of that harassment.
            </li>
          </ul>
        </div>

        <TipForm />
      </div>
    </section>
  );
}
