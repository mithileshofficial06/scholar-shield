import Link from 'next/link';
import type { CSSProperties } from 'react';
import { HeroGraph } from './components/HeroGraph';

const STACK = [
  ['PostgreSQL', 'pg_trgm'],
  ['BullMQ', 'Redis'],
  ['FastAPI', 'Python'],
  ['Tesseract', 'OCR'],
  ['Express', 'TypeScript'],
  ['Next.js', 'App Router'],
  ['MinIO', 'S3 storage'],
  ['Docker', 'Compose'],
] as const;

const PROOF = [
  { value: '154', label: 'tests passing' },
  { value: '17/17', label: 'known cases surfaced' },
  { value: '0', label: 'automated verdicts' },
];

const d = (n: number) => ({ '--d': n }) as CSSProperties;

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div className="hero-bg" aria-hidden="true">
          <div className="blob blob-1" />
          <div className="blob blob-2" />
          <div className="blob blob-3" />
          <div className="hero-grid" />
        </div>

        <div className="container hero-inner">
          <div>
            <span className="hero-badge rise" style={d(0)}>
              <b>New</b> Scholarship fraud risk-triage
            </span>

            <h1 className="hero-title">
              <span className="line rise" style={d(1)}>
                The certificate is real.
              </span>
              <span className="line rise" style={d(2)}>
                <span className="gradient-text">The income isn&rsquo;t.</span>
              </span>
            </h1>

            <p className="hero-lede rise" style={d(3)}>
              State portals only check <strong>whether a certificate was issued</strong>. The
              common fraud passes that check. ScholarShield compares applications{' '}
              <strong>against each other</strong> — where a family declaring two different incomes
              becomes impossible to miss.
            </p>

            <div className="hero-actions rise" style={d(4)}>
              <Link href="/dashboard" className="btn btn-primary">
                Open reviewer queue
                <ArrowIcon />
              </Link>
              <a href="#how-it-works" className="btn btn-ghost">
                See how it works
              </a>
            </div>

            <ul className="hero-proof rise" style={d(5)}>
              {PROOF.map((item) => (
                <li key={item.label}>
                  <CheckIcon />
                  <span>
                    <strong>{item.value}</strong> {item.label}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <HeroGraph />
        </div>
      </section>

      <div className="marquee" aria-label="Technology stack">
        <div className="marquee-track">
          {[...STACK, ...STACK].map(([name, detail], index) => (
            <span key={index} className="marquee-item" aria-hidden={index >= STACK.length}>
              <b>{name}</b> {detail}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
