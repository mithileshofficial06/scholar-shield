import { HouseholdDiagram } from './HouseholdDiagram';

const PIPELINE = [
  {
    title: 'OCR extraction',
    body: 'Fields lifted from the submitted certificate — name, income, certificate number, issuing office, issue date.',
    tag: 'Python · Tesseract',
  },
  {
    title: 'Document forensics',
    body: 'Error level analysis and file-metadata consistency, producing a bounded tamper score.',
    tag: 'Python · Pillow',
  },
  {
    title: 'Certificate authenticity',
    body: 'A pre-filled link to the state verification portal. No government portal is ever scraped.',
    tag: 'Adapter · manual-first',
  },
  {
    title: 'Household reconciliation',
    body: 'Normalize, fuzzy-resolve, detect components, run contradiction rules across the whole household.',
    tag: 'The core engine',
    core: true,
  },
  {
    title: 'Explainable scoring',
    body: 'Versioned weighted rules. Every flag carries a reason string, rule id, and config version.',
    tag: 'rules.v1.json',
  },
];

const PRINCIPLES = [
  {
    rule: 'Rule 01',
    title: 'No automated verdicts',
    body: 'Score changes queue position and nothing else. An application reaches a terminal state only through a reviewer id and a typed reason.',
  },
  {
    rule: 'Rule 02',
    title: 'Manual verification first',
    body: 'The system generates a verification link for every certificate. It never scrapes a portal and never infers a result it did not receive.',
  },
  {
    rule: 'Rule 03',
    title: 'Synthetic data only',
    body: 'Every applicant, family, address, and certificate here is generated. No real student document is ingested at any point.',
  },
  {
    rule: 'Rule 04',
    title: 'Append-only audit',
    body: 'Decisions are immutable at the database level — the application role holds no update or delete grant on the audit log.',
  },
  {
    rule: 'Rule 05',
    title: 'Every flag explains itself',
    body: 'No black-box model. A reviewer sees the contradiction, the values behind it, and the weight it carried.',
  },
  {
    rule: 'Rule 06',
    title: 'Corroboration required',
    body: 'No single field links a household. Not a shared surname, not a shared address, not a shared phone. A false merge flags two innocent families.',
  },
];

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Scholarship fraud risk-triage</p>
          <h1 className="display">
            The certificate is real.
            <br />
            <em>The income isn&rsquo;t.</em>
          </h1>
          <p className="lede">
            State portals answer one question — <strong>was this certificate issued?</strong> The
            common fraud pattern passes that check, because the certificate genuinely was issued and
            still misrepresents the family. ScholarShield reconciles applications{' '}
            <strong>against each other</strong>, where that pattern becomes visible.
          </p>
        </div>

        <div className="stat-stack">
          <div className="stat">
            <span className="stat-value is-signal">5</span>
            <span className="stat-label">
              Contradiction rules
              <br />
              in the core engine
            </span>
          </div>
          <div className="stat">
            <span className="stat-value">77</span>
            <span className="stat-label">
              Tests passing,
              <br />
              no database required
            </span>
          </div>
          <div className="stat">
            <span className="stat-value">0</span>
            <span className="stat-label">
              Automated verdicts,
              <br />
              by construction
            </span>
          </div>
        </div>
      </section>

      <div className="guardrail">
        <span className="guardrail-key">Guardrail</span>
        <p style={{ margin: 0 }}>
          <strong>Decision support, not a verdict.</strong> ScholarShield determines the order in
          which a human reviews applications. It does not approve, reject, or accuse anyone, and no
          code path exists for it to do so.
        </p>
      </div>

      <section className="section">
        <div className="section-head">
          <span className="section-index">01</span>
          <h2 className="section-title">What the engine sees</h2>
          <span className="section-note">Synthetic household · illustrative</span>
        </div>

        <div className="diagram-frame">
          <HouseholdDiagram />
        </div>

        <div className="diagram-caption">
          <span>
            <b>Dashed boundary</b> — a household the resolver inferred, never one it was told about
          </span>
          <span>
            <b>Grey edges</b> — the matches that built it, each rejectable by a reviewer
          </span>
          <span>
            <b>Red arc</b> — the finding, visible only once the three sit together
          </span>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <span className="section-index">02</span>
          <h2 className="section-title">Pipeline</h2>
          <span className="section-note">Async · idempotent per stage</span>
        </div>

        <div className="pipeline">
          {PIPELINE.map((step, index) => (
            <article key={step.title} className={`step${step.core ? ' is-core' : ''}`}>
              <span className="step-index">{String(index + 1).padStart(2, '0')}</span>
              <h3 className="step-title">{step.title}</h3>
              <p className="step-body">{step.body}</p>
              <span className="step-tag">{step.tag}</span>
            </article>
          ))}
        </div>

        <p className="lede" style={{ marginTop: '1.75rem' }}>
          Step four re-runs for <strong>every application in a household</strong> when a new one
          joins it. A sibling filing today can raise a brother&rsquo;s score from last week — a
          contradiction is a property of the family, not of one upload.
        </p>
      </section>

      <section className="section">
        <div className="section-head">
          <span className="section-index">03</span>
          <h2 className="section-title">Constraints</h2>
          <span className="section-note">Enforced in schema and tests</span>
        </div>

        <div className="principles">
          {PRINCIPLES.map((item) => (
            <article key={item.rule} className="principle">
              <span className="principle-rule">{item.rule}</span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <span className="section-index">04</span>
          <h2 className="section-title">Build status</h2>
        </div>

        <div className="panel">
          <p className="stamp">Week 2 complete</p>
          <p className="lede" style={{ marginTop: '1.25rem' }}>
            Schema, auth, and the applicant/reviewer boundary are in place. The Tier 1 engine runs
            end to end — normalization, fuzzy entity resolution, connected-component household
            detection, and all five contradiction rules against a versioned config. Next is the
            synthetic corpus and its degradation pipeline.
          </p>
        </div>
      </section>
    </>
  );
}
