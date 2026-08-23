'use client';

import { useState } from 'react';

/**
 * Applicant submission — Week 1 shell, restyled.
 *
 * Fields are grouped by what consumes them downstream rather than by what is
 * convenient to type: the identity block is what the household resolver matches
 * on, the assessment block is what the scoring engine reads. Wiring to
 * POST /applications and document upload lands in Week 2's persistence pass.
 */
export default function ApplyPage() {
  const [submitted, setSubmitted] = useState(false);

  return (
    <>
      <section className="hero" style={{ paddingBottom: '2.5rem' }}>
        <div className="hero-copy">
          <p className="eyebrow">Applicant submission</p>
          <h1 className="display">Apply</h1>
          <p className="lede">
            You will be told the committee&rsquo;s decision when review is complete. Risk scores and
            flags are never shown to applicants — that boundary is enforced at the serializer, not
            just in this interface.
          </p>
        </div>
      </section>

      <div className="guardrail">
        <span className="guardrail-key">Synthetic</span>
        <p style={{ margin: 0 }}>
          <strong>This deployment carries generated data only.</strong> Do not upload a real income
          certificate or any real person&rsquo;s details.
        </p>
      </div>

      <section className="section">
        {submitted ? (
          <div className="panel">
            <p className="stamp">Submission received</p>
            <p className="lede" style={{ marginTop: '1.25rem' }}>
              Your application has entered the review queue. Nothing about its position or
              assessment is visible to you, by design.
            </p>
            <div className="form-actions">
              <button type="button" onClick={() => setSubmitted(false)}>
                Submit another
              </button>
            </div>
          </div>
        ) : (
          <form
            className="panel"
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(true);
            }}
          >
            <fieldset className="form-section">
              <legend>01 — Identity</legend>
              <div className="field-grid">
                <div className="field">
                  <label htmlFor="applicantName">Applicant full name</label>
                  <input id="applicantName" name="applicantName" placeholder="As on the certificate" required />
                </div>
                <div className="field">
                  <label htmlFor="guardianName">Guardian full name</label>
                  <input id="guardianName" name="guardianName" placeholder="Parent or guardian" required />
                  <span className="hint">Matched across applications to detect households.</span>
                </div>
                <div className="field">
                  <label htmlFor="guardianPhone">Guardian phone</label>
                  <input id="guardianPhone" name="guardianPhone" inputMode="tel" placeholder="10 digits" />
                </div>
              </div>
            </fieldset>

            <fieldset className="form-section">
              <legend>02 — Residence</legend>
              <div className="field-grid">
                <div className="field is-wide">
                  <label htmlFor="addressLine">Address</label>
                  <input id="addressLine" name="addressLine" placeholder="Door number, street, locality" required />
                </div>
                <div className="field">
                  <label htmlFor="district">District</label>
                  <input id="district" name="district" required />
                </div>
                <div className="field">
                  <label htmlFor="pincode">PIN code</label>
                  <input id="pincode" name="pincode" inputMode="numeric" maxLength={6} />
                </div>
              </div>
            </fieldset>

            <fieldset className="form-section">
              <legend>03 — Assessment</legend>
              <div className="field-grid">
                <div className="field">
                  <label htmlFor="declaredAnnualIncome">Annual household income (₹)</label>
                  <input
                    id="declaredAnnualIncome"
                    name="declaredAnnualIncome"
                    type="number"
                    min={0}
                    placeholder="0"
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="declaredFamilySize">Family size</label>
                  <input
                    id="declaredFamilySize"
                    name="declaredFamilySize"
                    type="number"
                    min={1}
                    max={30}
                    required
                  />
                  <span className="hint">Income is compared per head, not per household.</span>
                </div>
              </div>
            </fieldset>

            <fieldset className="form-section">
              <legend>04 — Certificate</legend>
              <div className="field-grid">
                <div className="field">
                  <label htmlFor="certificateId">Certificate number</label>
                  <input id="certificateId" name="certificateId" placeholder="TN-CHN-2026-000000" />
                </div>
                <div className="field">
                  <label htmlFor="issuingOffice">Issuing office</label>
                  <input id="issuingOffice" name="issuingOffice" placeholder="Taluk office" />
                </div>
                <div className="field">
                  <label htmlFor="certificateIssueDate">Issue date</label>
                  <input id="certificateIssueDate" name="certificateIssueDate" type="date" />
                </div>
                <div className="field is-wide">
                  <label htmlFor="certificate">Income certificate (PDF or image)</label>
                  <input id="certificate" name="certificate" type="file" accept=".pdf,image/*" />
                  <span className="hint">Upload wiring lands with the persistence pass.</span>
                </div>
              </div>
            </fieldset>

            <div className="form-actions">
              <button type="submit">Submit application</button>
              <span className="hint" style={{ maxWidth: '38ch' }}>
                Submitting records a declaration. Knowingly false declarations are a criminal
                offence under Indian law.
              </span>
            </div>
          </form>
        )}
      </section>
    </>
  );
}
