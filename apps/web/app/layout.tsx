import type { Metadata } from 'next';
import Link from 'next/link';
import { Inter, JetBrains_Mono, Sora } from 'next/font/google';
import { SessionControls } from './components/SessionControls';
import { SiteNav } from './components/SiteNav';
import { getSession } from './lib/session';
import './globals.css';
import './styles/hero.css';
import './styles/home.css';
import './styles/pages.css';
import './styles/queue.css';
import './styles/auth.css';
import './styles/detail.css';

/**
 * Self-hosted at build time by next/font — no runtime request to Google, no
 * layout shift, and the page still renders correctly offline once built.
 */
const sora = Sora({
  subsets: ['latin'],
  weight: ['400', '600', '700', '800'],
  variable: '--font-sora',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ScholarShield — Scholarship Fraud Risk-Triage',
  description:
    'An entity-resolution and contradiction-detection engine over scholarship applications. Decision support, not a verdict.',
};

/**
 * Marks <html> as JS-capable before first paint, so scroll-reveal content is
 * only hidden when something will actually reveal it again.
 */
const JS_FLAG = "document.documentElement.classList.add('js')";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={`${sora.variable} ${inter.variable} ${jetbrains.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: JS_FLAG }} />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>

        <header className="site-header">
          <div className="container site-header-inner">
            <Link href="/" className="brand" aria-label="ScholarShield home">
              <ShieldMark id="shield-header" />
              <span className="brand-name">
                Scholar<span>Shield</span>
              </span>
            </Link>

            <SiteNav role={session?.role ?? null} />

            <span className="status-pill" title="Every record in this deployment is generated">
              <span className="live-dot" aria-hidden="true" />
              Synthetic data only
            </span>

            <SessionControls role={session?.role ?? null} />
          </div>
        </header>

        <main id="main">{children}</main>

        <footer className="site-footer">
          <div className="container">
            <div className="footer-grid">
              <div>
                <Link href="/" className="brand">
                  <ShieldMark id="shield-footer" />
                  <span>
                    Scholar<span style={{ color: 'var(--text-2)', fontWeight: 500 }}>Shield</span>
                  </span>
                </Link>
                <p>
                  Cross-application contradiction detection for scholarship committees. It decides
                  the order a human reviews in — never the outcome.
                </p>
              </div>

              <div>
                <p className="footer-title">Product</p>
                <ul className="footer-list">
                  <li>
                    <Link href="/">Overview</Link>
                  </li>
                  <li>
                    <Link href="/apply">Apply</Link>
                  </li>
                  <li>
                    <Link href="/dashboard">Reviewer queue</Link>
                  </li>
                </ul>
              </div>

              <div>
                <p className="footer-title">Guarantees</p>
                <ul className="footer-list">
                  <li>No automated verdicts</li>
                  <li>Append-only audit log</li>
                  <li>Every flag explains itself</li>
                </ul>
              </div>
            </div>

            <div className="footer-bottom">
              <span>© {new Date().getFullYear()} ScholarShield · MIT licensed</span>
              <span>Synthetic data only · Decision support, never a verdict</span>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}

/** `id` must differ per instance: two SVGs defining one gradient id is invalid HTML. */
function ShieldMark({ id }: { id: string }) {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="0.5" stopColor="#7c8cff" />
          <stop offset="1" stopColor="#b18cff" />
        </linearGradient>
      </defs>
      <path
        d="M16 2.5 5 6.6v8.2c0 7.1 4.7 12.4 11 14.7 6.3-2.3 11-7.6 11-14.7V6.6L16 2.5Z"
        fill={`url(#${id})`}
      />
      <path
        d="m11 16.2 3.4 3.4 6.8-7"
        fill="none"
        stroke="#060912"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
