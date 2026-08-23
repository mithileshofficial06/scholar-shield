import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'ScholarShield',
  description: 'Scholarship fraud risk-triage for college committees',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="masthead">
            <h1>ScholarShield</h1>
            <nav>
              <Link href="/">Overview</Link>
              <Link href="/apply">Apply</Link>
              <Link href="/dashboard">Review queue</Link>
            </nav>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
