import type { Metadata } from 'next';
import Link from 'next/link';
import { Archivo, JetBrains_Mono } from 'next/font/google';
import { BackgroundGrid } from './BackgroundGrid';
import './globals.css';

/**
 * Self-hosted at build time by next/font — no runtime request to Google, no
 * layout shift, and the page still renders correctly offline once built.
 */
const display = Archivo({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800', '900'],
  variable: '--font-display',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ScholarShield — Scholarship Fraud Risk-Triage',
  description:
    'An entity-resolution and contradiction-detection engine over scholarship applications. Decision support, not a verdict.',
};

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/apply', label: 'Apply' },
  { href: '/dashboard', label: 'Queue' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body>
        <BackgroundGrid />

        <header className="masthead">
          <div className="masthead-inner">
            <Link href="/" className="wordmark">
              <span className="wordmark-mark" aria-hidden="true" />
              <span className="wordmark-text">
                Scholar<em>Shield</em>
              </span>
            </Link>

            <nav aria-label="Primary">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href}>
                  {item.label}
                </Link>
              ))}
            </nav>

            <div className="masthead-status" title="Synthetic data only">
              <span className="pulse" aria-hidden="true" />
              <span>Synthetic corpus</span>
            </div>
          </div>
        </header>

        <main className="shell">{children}</main>

        <footer className="colophon">
          <span>ScholarShield</span>
          <span>Decision support · never a verdict</span>
          <span>Synthetic data only</span>
        </footer>
      </body>
    </html>
  );
}
