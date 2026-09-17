import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { CountUp } from './components/CountUp';
import { HeroGraph } from './components/HeroGraph';
import {
  ArrowIcon,
  CheckIcon,
  CrossIcon,
  DatabaseIcon,
  EyeIcon,
  ForensicsIcon,
  GraphIcon,
  LinkIcon,
  LockIcon,
  ScaleIcon,
  ScanIcon,
  UsersIcon,
} from './components/Icons';
import { Reveal } from './components/Reveal';

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

const SIGNALS = [
  { text: 'A sibling declares a different household income', severity: 'high' },
  { text: 'One guardian appears with two different incomes', severity: 'high' },
  { text: '“Unrelated” low-income applicants share one address', severity: 'medium' },
] as const;

const PIPELINE: { title: string; body: string; tag: string; icon: ReactNode; core?: boolean }[] = [
  {
    title: 'Read the certificate',
    body: 'OCR lifts name, income, certificate number, office and date — each with its confidence.',
    tag: 'Python · Tesseract',
    icon: <ScanIcon />,
  },
  {
    title: 'Check the document',
    body: 'Error-level analysis and metadata consistency produce a bounded tamper score.',
    tag: 'Forensics',
    icon: <ForensicsIcon />,
  },
  {
    title: 'Link for verification',
    body: 'A pre-filled link to the state portal. No government site is ever scraped.',
    tag: 'Manual-first',
    icon: <LinkIcon />,
  },
  {
    title: 'Reconcile the household',
    body: 'Normalize, fuzzy-match, group into households, then run contradiction rules across them.',
    tag: 'Core engine',
    icon: <GraphIcon />,
    core: true,
  },
  {
    title: 'Score and explain',
    body: 'Versioned weighted rules. Every flag carries its reason, rule id and config version.',
    tag: 'rules.v1.json',
    icon: <ScaleIcon />,
  },
];

const METRICS = [
  { label: 'Known-pattern recall', value: 100, decimals: 0, suffix: '%', note: 'A consistency check, not evidence — the rules were written for these.' },
  { label: 'Precision in top 10', value: 100, decimals: 0, suffix: '%', note: 'Against a 51.5% base rate of applications that should surface.' },
  { label: 'Queue lift', value: 1.94, decimals: 2, suffix: '×', note: 'The top 10% of the queue holds real cases 1.94× as often as the queue overall.' },
  { label: 'OCR field accuracy', value: 92.5, decimals: 1, suffix: '%', note: 'On certificates degraded like real phone photos and scans.' },
  { label: 'Equity cases passed', value: 7, decimals: 0, suffix: '/7', note: 'Legitimate but irregular families never reach high severity.' },
  { label: 'Tamper detection AUC', value: 0.51, decimals: 3, suffix: '', note: 'Chance level — so document forensics carries no scoring weight.' },
];

const PRINCIPLES = [
  { title: 'No automated verdicts', body: 'A score changes queue position and nothing else. Only a reviewer with a typed reason can decide.', icon: <ScaleIcon /> },
  { title: 'Manual verification first', body: 'Every certificate gets a verification link. The system never scrapes a portal or invents a result.', icon: <LinkIcon /> },
  { title: 'Synthetic data only', body: 'Every applicant, family, address and certificate here is generated. No real student is ingested.', icon: <DatabaseIcon /> },
  { title: 'Append-only audit', body: 'The database itself rejects edits and deletes on the audit log — not just the application code.', icon: <LockIcon /> },
  { title: 'Every flag explains itself', body: 'No black box. Reviewers see the contradiction, the values behind it, and the weight it carried.', icon: <EyeIcon /> },
  { title: 'Corroboration required', body: 'No single shared field links a household. A false merge would flag two innocent families.', icon: <UsersIcon /> },
];

const ROADMAP = [
  { week: 'Week 1', title: 'Scaffold & sealed holdout', status: 'done' },
  { week: 'Week 2', title: 'Household engine', status: 'done' },
  { week: 'Week 3', title: 'Synthetic corpus', status: 'done' },
  { week: 'Week 4', title: 'OCR & forensics', status: 'done' },
  { week: 'Week 5', title: 'Scoring & metrics', status: 'done' },
  { week: 'Week 6', title: 'Review workflow', status: 'active' },
  { week: 'Week 7', title: 'Polish & deploy', status: 'next' },
] as const;

const d = (n: number) => ({ '--d': n }) as CSSProperties;

export default function HomePage() {
  return (
    <>
      {/* ------------------------------------------------------------ hero */}
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

      {/* --------------------------------------------------------- problem */}
      <section className="section" id="problem">
        <div className="container">
          <Reveal className="section-head is-center">
            <span className="eyebrow">
              <span className="eyebrow-num">01</span> The gap
            </span>
            <h2 className="section-title">A genuine certificate can still carry a false income</h2>
            <p className="section-lede">
              Verification today asks one question per document. The fraud only shows up when you
              ask a question about the whole family.
            </p>
          </Reveal>

          <div className="compare">
            <Reveal index={0} className="compare-card card">
              <p className="compare-kicker">What state portals check</p>
              <p className="compare-question">&ldquo;Was this certificate issued?&rdquo;</p>
              <dl className="portal-mock" aria-label="Example state portal lookup result">
                <div>
                  <dt>Certificate no.</dt>
                  <dd className="data">TN-CBE-2026-660214</dd>
                </div>
                <div>
                  <dt>Issuing office</dt>
                  <dd>Coimbatore North Taluk</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd className="portal-ok">Issued · valid</dd>
                </div>
                <div>
                  <dt>Declared income</dt>
                  <dd className="portal-muted">Not compared with anything</dd>
                </div>
              </dl>
              <div className="compare-result is-pass">
                <span className="compare-icon">
                  <CheckIcon />
                </span>
                <div>
                  <strong>Yes — it&rsquo;s genuine.</strong>
                  <p>So the false income on it passes straight through.</p>
                </div>
              </div>
            </Reveal>

            <Reveal index={1} className="compare-card compare-card-hero card">
              <p className="compare-kicker is-brand">What ScholarShield checks</p>
              <p className="compare-question">&ldquo;Does it agree with the rest of the household?&rdquo;</p>
              <ul className="signal-list">
                {SIGNALS.map((signal) => (
                  <li key={signal.text}>
                    <span>{signal.text}</span>
                    <span className={`sev-pill sev-${signal.severity}`}>{signal.severity}</span>
                  </li>
                ))}
              </ul>
              <div className="compare-result is-flag">
                <span className="compare-icon">
                  <CrossIcon />
                </span>
                <div>
                  <strong>Flagged for earlier review.</strong>
                  <p>Moved up the queue — never rejected by the system.</p>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------- how it works */}
      <section className="section section-band" id="how-it-works">
        <div className="container">
          <Reveal className="section-head">
            <span className="eyebrow">
              <span className="eyebrow-num">02</span> How it works
            </span>
            <h2 className="section-title">Five stages, one decision left to a human</h2>
            <p className="section-lede">
              Every upload runs the same pipeline in a background worker. Each stage is idempotent,
              so a retry resumes where it failed instead of starting over.
            </p>
          </Reveal>

          <ol className="pipeline">
            {PIPELINE.map((step, index) => (
              <Reveal
                as="li"
                key={step.title}
                index={index}
                className={`pipeline-step card card-hover${step.core ? ' is-core' : ''}`}
              >
                <div className="pipeline-top">
                  <span className="icon-tile">{step.icon}</span>
                  <span className="pipeline-num">{String(index + 1).padStart(2, '0')}</span>
                </div>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
                <span className="pipeline-tag">{step.tag}</span>
              </Reveal>
            ))}
          </ol>

          <Reveal className="callout">
            <span className="callout-icon">
              <GraphIcon />
            </span>
            <p>
              Stage four re-runs for <strong>every application in a household</strong> when a new
              one joins it. A sibling filing today can raise a brother&rsquo;s score from last week
              — a contradiction belongs to the family, not to one upload.
            </p>
          </Reveal>
        </div>
      </section>

      {/* -------------------------------------------------------- measured */}
      <section className="section" id="measured">
        <div className="container">
          <Reveal className="section-head">
            <span className="eyebrow">
              <span className="eyebrow-num">03</span> Measured, not asserted
            </span>
            <h2 className="section-title">The honest number comes first</h2>
            <p className="section-lede">
              Every figure is generated by <code>npm run metrics</code>, never typed by hand. Fraud
              patterns were sealed in git <strong>before any detection rule existed</strong> — so
              the headline accuracy can&rsquo;t be tuned to look good.
            </p>
          </Reveal>

          <div className="metrics">
            <Reveal className="metric-feature card">
              <p className="metric-kicker">Holdout recall · the real accuracy</p>
              <p className="metric-hero">
                <CountUp value={17.6} decimals={1} suffix="%" />
              </p>
              <div className="meter" aria-hidden="true">
                <span style={{ '--fill': '17.6%' } as CSSProperties} />
              </div>
              <p className="metric-feature-sub">
                <strong>6 of 34</strong> sealed fraud cases surfaced
              </p>
              <p className="metric-feature-body">
                The rules catch contradictions inside a household. The sealed set also holds seven
                other fraud patterns they have no rule for — published here rather than hidden.
              </p>
            </Reveal>

            <div className="metric-grid">
              {METRICS.map((metric, index) => (
                <Reveal key={metric.label} index={index} className="metric-card card card-hover">
                  <p className="metric-label">{metric.label}</p>
                  <p className="metric-value">
                    <CountUp value={metric.value} decimals={metric.decimals} suffix={metric.suffix} />
                  </p>
                  <p className="metric-note">{metric.note}</p>
                </Reveal>
              ))}
            </div>
          </div>

          <p className="footnote">Synthetic corpus only · generated 24 Aug 2026 · regenerate with npm run metrics</p>
        </div>
      </section>

      {/* ------------------------------------------------------ principles */}
      <section className="section section-band" id="principles">
        <div className="container">
          <Reveal className="section-head is-center">
            <span className="eyebrow">
              <span className="eyebrow-num">04</span> Guarantees
            </span>
            <h2 className="section-title">Built so it can&rsquo;t quietly become a judge</h2>
            <p className="section-lede">
              Design commitments carried into the database schema, the API serializers and the test
              suite — not just written into the docs.
            </p>
          </Reveal>

          <div className="principles">
            {PRINCIPLES.map((item, index) => (
              <Reveal key={item.title} index={index % 3} className="principle card card-hover">
                <span className="icon-tile">{item.icon}</span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- roadmap */}
      <section className="section" id="progress">
        <div className="container">
          <Reveal className="section-head">
            <span className="eyebrow">
              <span className="eyebrow-num">05</span> Build status
            </span>
            <h2 className="section-title">Five of seven milestones shipped</h2>
            <p className="section-lede">
              The full runtime path is verified: 33 synthetic applications ran through the live
              pipeline and produced exactly the flags the test harness predicts.
            </p>
          </Reveal>

          <ol className="roadmap">
            {ROADMAP.map((item, index) => (
              <Reveal as="li" key={item.week} index={index} className={`roadmap-item is-${item.status}`}>
                <span className="roadmap-dot" aria-hidden="true">
                  {item.status === 'done' ? <CheckIcon /> : null}
                </span>
                <span className="roadmap-week">{item.week}</span>
                <span className="roadmap-title">{item.title}</span>
                <span className="roadmap-status">
                  {item.status === 'done' ? 'Shipped' : item.status === 'active' ? 'In progress' : 'Up next'}
                </span>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* ------------------------------------------------------------- cta */}
      <section className="section cta-section">
        <div className="container">
          <Reveal className="cta card">
            <div className="cta-glow" aria-hidden="true" />
            <h2>See the queue the engine built</h2>
            <p>
              Applications ordered by risk, every flag with its reason attached, and a human
              decision required at every exit.
            </p>
            <div className="cta-actions">
              <Link href="/dashboard" className="btn btn-primary">
                Open reviewer queue
                <ArrowIcon />
              </Link>
              <Link href="/apply" className="btn btn-ghost">
                Try the application form
              </Link>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
