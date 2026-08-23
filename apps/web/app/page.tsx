export default function HomePage() {
  return (
    <>
      <div className="notice">
        <strong>Decision support, not a verdict.</strong> ScholarShield determines the order in
        which a human reviews applications. It does not approve, reject, or accuse anyone, and no
        code path exists for it to do so.
      </div>

      <div className="card">
        <h2>What this does</h2>
        <p>
          Existing certificate lookups answer <em>&ldquo;was this certificate issued?&rdquo;</em>{' '}
          The common fraud pattern is a certificate that <em>was</em> genuinely issued and still
          misrepresents the family&rsquo;s position. ScholarShield reconciles applications against
          one another to surface that: a sibling declaring a different household income, several
          &ldquo;unrelated&rdquo; low-income applicants at one address, one guardian appearing with
          two incomes.
        </p>
      </div>

      <div className="card">
        <h2>Pipeline</h2>
        <ol>
          <li>OCR extraction from the submitted certificate</li>
          <li>Document forensics — error level analysis and metadata consistency</li>
          <li>Certificate authenticity — a pre-filled manual verification link</li>
          <li>
            <strong>Household reconciliation</strong> — normalize, fuzzy-resolve, detect
            components, run contradiction rules
          </li>
          <li>Explainable risk scoring against a versioned rule config</li>
        </ol>
        <p>
          Step 4 is the core engine. When a new application joins a household, every application in
          that household is re-scored — a contradiction is a property of the family, not of one
          upload.
        </p>
      </div>

      <div className="card">
        <h2>Status</h2>
        <p>
          <span className="stamp">Week 2 · in progress</span>
        </p>
        <p>
          Schema, auth, and the applicant/reviewer boundary are in place. Identity normalization —
          the input layer of the household engine — is built and tested. Fuzzy resolution and the
          contradiction rules land next.
        </p>
      </div>
    </>
  );
}
