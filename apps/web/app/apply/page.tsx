'use client';

import { useState } from 'react';

/**
 * Applicant submission form — Week 1 shell.
 *
 * The fields here are exactly what the household reconciliation engine needs to
 * normalize and resolve on (guardian name, address, phone), plus what the scoring
 * engine reads (income, family size, certificate metadata). Wiring to
 * POST /applications and the document upload lands in Week 2.
 */
export default function ApplyPage() {
  const [submitted, setSubmitted] = useState(false);

  return (
    <>
      <div className="notice">
        <strong>Synthetic demo.</strong> This deployment carries generated data only. Do not upload
        a real income certificate or any real person&rsquo;s details.
      </div>

      <div className="card">
        <h2>Scholarship application</h2>

        {submitted ? (
          <p>
            Submission received. You will be told the committee&rsquo;s decision when review is
            complete.
          </p>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(true);
            }}
          >
            <div className="grid-2">
              <div className="field">
                <label htmlFor="applicantName">Applicant full name</label>
                <input id="applicantName" name="applicantName" required />
              </div>

              <div className="field">
                <label htmlFor="guardianName">Guardian full name</label>
                <input id="guardianName" name="guardianName" required />
                <span className="hint">As written on the income certificate.</span>
              </div>

              <div className="field">
                <label htmlFor="guardianPhone">Guardian phone</label>
                <input id="guardianPhone" name="guardianPhone" inputMode="tel" />
              </div>

              <div className="field">
                <label htmlFor="district">District</label>
                <input id="district" name="district" required />
              </div>
            </div>

            <div className="field">
              <label htmlFor="addressLine">Address</label>
              <input id="addressLine" name="addressLine" required />
            </div>

            <div className="grid-2">
              <div className="field">
                <label htmlFor="pincode">PIN code</label>
                <input id="pincode" name="pincode" inputMode="numeric" />
              </div>

              <div className="field">
                <label htmlFor="declaredAnnualIncome">Declared annual household income (₹)</label>
                <input
                  id="declaredAnnualIncome"
                  name="declaredAnnualIncome"
                  type="number"
                  min={0}
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
                <span className="hint">Used to compare income per head, not per household.</span>
              </div>

              <div className="field">
                <label htmlFor="certificateId">Certificate number</label>
                <input id="certificateId" name="certificateId" />
              </div>

              <div className="field">
                <label htmlFor="issuingOffice">Issuing office</label>
                <input id="issuingOffice" name="issuingOffice" />
              </div>

              <div className="field">
                <label htmlFor="certificateIssueDate">Certificate issue date</label>
                <input id="certificateIssueDate" name="certificateIssueDate" type="date" />
              </div>
            </div>

            <div className="field">
              <label htmlFor="certificate">Income certificate (PDF or image)</label>
              <input id="certificate" name="certificate" type="file" accept=".pdf,image/*" />
              <span className="hint">Upload wiring lands in Week 2.</span>
            </div>

            <button type="submit">Submit application</button>
          </form>
        )}
      </div>
    </>
  );
}
