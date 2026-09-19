import Link from 'next/link';

import { ArrowIcon, AlertIcon } from './components/Icons';

/**
 * Every unknown URL, and every `notFound()` a page calls.
 *
 * Without this, Next renders its own bare 404 — dark, unstyled, and outside the
 * site's colours, so it blanked half the logo in the header above it.
 */
export default function NotFound() {
  return (
    <section className="section auth-section">
      <div className="container auth-shell">
        <div className="card auth-card">
          <span className="auth-icon">
            <AlertIcon />
          </span>
          <h1>Page not found</h1>
          <p className="auth-lede">
            There is nothing at this address. If you followed a sign-in or invitation link, it may
            have been copied incompletely — open it from the email again.
          </p>
          <div className="not-found-actions">
            <Link href="/" className="btn btn-primary">
              Go to the overview
              <ArrowIcon />
            </Link>
            <Link href="/status" className="btn btn-ghost">
              Check an application
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
