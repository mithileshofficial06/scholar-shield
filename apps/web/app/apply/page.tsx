'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { ArrowIcon, CheckIcon, LockIcon, UploadIcon, AlertIcon, DatabaseIcon } from '../components/Icons';

/**
 * Applicant submission.
 *
 * Fields are grouped by what consumes them downstream rather than by what is
 * convenient to type: the identity block is what the household resolver matches
 * on, the assessment block is what the scoring engine reads.
 *
 * Not yet wired to the API — that lands with the upload endpoint. Until then the
 * success state says so plainly instead of claiming the application was queued.
 */

const SECTIONS = [
  { title: 'Identity', hint: 'Who is applying, and their guardian' },
  { title: 'Residence', hint: 'Where the household lives' },
  { title: 'Assessment', hint: 'Declared income and family size' },
  { title: 'Certificate', hint: 'The income certificate itself' },
];

export default function ApplyPage() {
  const [submitted, setSubmitted] = useState(false);
  const [active, setActive] = useState(0);
  const [complete, setComplete] = useState<boolean[]>(SECTIONS.map(() => false));
  const [fileName, setFileName] = useState<string | null>(null);
  const sectionRefs = useRef<(HTMLFieldSetElement | null)[]>([]);

  /** A section is complete once every required field in it has a value. */
  const recompute = () => {
    setComplete(
      sectionRefs.current.map((fieldset) => {
        if (!fieldset) return false;
        const fields = Array.from(fieldset.querySelectorAll<HTMLInputElement>('input'));
        const required = fields.filter((f) => f.required);
        const pool = required.length > 0 ? required : fields;
        return required.length > 0 ? pool.every((f) => f.value.trim() !== '') : pool.some((f) => f.value.trim() !== '');
      }),
    );
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const doneCount = complete.filter(Boolean).length;

  return (
    <>
      <section className="page-hero">
        <div className="page-hero-bg" aria-hidden="true" />
        <div className="container">
          <span className="eyebrow rise" style={{ '--d': 0 } as React.CSSProperties}>
            <span className="eyebrow-num">
              <DatabaseIcon />
            </span>
            Applicant portal · synthetic demo
          </span>
          <h1 className="page-title rise" style={{ '--d': 1 } as React.CSSProperties}>
            Apply for the scholarship
          </h1>
          <p className="page-lede rise" style={{ '--d': 2 } as React.CSSProperties}>
            Four short sections. You&rsquo;ll hear the committee&rsquo;s decision once review is
            complete — risk scores and flags are never shown to applicants.
          </p>
        </div>
      </section>

      <section className="section apply-section">
        <div className="container apply-layout">
          <aside className="apply-aside">
            <div className="card progress-card">
              <div className="progress-head">
                <p className="progress-title">Your progress</p>
                <p className="progress-count tabular">
                  {doneCount}/{SECTIONS.length}
                </p>
              </div>
              <div className="progress-bar" aria-hidden="true">
                <span style={{ width: `${(doneCount / SECTIONS.length) * 100}%` }} />
              </div>

              <ol className="step-list">
                {SECTIONS.map((section, index) => (
                  <li
                    key={section.title}
                    className={`step-item${active === index ? ' is-active' : ''}${complete[index] ? ' is-done' : ''}`}
                  >
                    <span className="step-dot">{complete[index] ? <CheckIcon /> : index + 1}</span>
                    <span>
                      <span className="step-name">{section.title}</span>
                      <span className="step-hint">{section.hint}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            <div className="card note-card">
              <p className="note-row">
                <span className="note-icon is-brand">
                  <LockIcon />
                </span>
                Scores and flags are withheld from applicants at the API serializer, not just
                hidden in this page.
              </p>
              <p className="note-row">
                <span className="note-icon is-warn">
                  <AlertIcon />
                </span>
                This deployment carries generated data only. Don&rsquo;t enter a real person&rsquo;s
                details or upload a real certificate.
              </p>
            </div>
          </aside>

          <div>
            {submitted ? (
              <div className="card success-card">
                <span className="success-icon">
                  <CheckIcon />
                </span>
                <h2>Preview complete</h2>
                <p>
                  Your answers passed the form&rsquo;s checks. This page isn&rsquo;t connected to
                  the API yet, so <strong>nothing was saved or queued</strong> — submission arrives
                  with the upload endpoint.
                </p>
                <div className="success-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setSubmitted(false)}>
                    Back to the form
                  </button>
                  <Link href="/" className="btn btn-ghost">
                    Return to overview
                  </Link>
                </div>
              </div>
            ) : (
              <form className="apply-form" onSubmit={onSubmit} onInput={recompute}>
                <fieldset
                  ref={(el) => {
                    sectionRefs.current[0] = el;
                  }}
                  className={`card form-card${active === 0 ? ' is-active' : ''}`}
                  onFocus={() => setActive(0)}
                >
                  <FormCardHead index={0} />
                  <div className="field-grid">
                    <Field id="applicantName" label="Applicant full name" placeholder="As printed on the certificate" required />
                    <Field
                      id="guardianName"
                      label="Guardian full name"
                      placeholder="Parent or guardian"
                      hint="Matched across applications to detect households."
                      required
                    />
                    <Field id="guardianPhone" label="Guardian phone" placeholder="10-digit mobile" inputMode="tel" maxLength={10} />
                  </div>
                </fieldset>

                <fieldset
                  ref={(el) => {
                    sectionRefs.current[1] = el;
                  }}
                  className={`card form-card${active === 1 ? ' is-active' : ''}`}
                  onFocus={() => setActive(1)}
                >
                  <FormCardHead index={1} />
                  <div className="field-grid">
                    <Field id="addressLine" label="Address" placeholder="Door number, street, locality" wide required />
                    <Field id="district" label="District" placeholder="e.g. Coimbatore" required />
                    <Field id="pincode" label="PIN code" placeholder="6 digits" inputMode="numeric" maxLength={6} />
                  </div>
                </fieldset>

                <fieldset
                  ref={(el) => {
                    sectionRefs.current[2] = el;
                  }}
                  className={`card form-card${active === 2 ? ' is-active' : ''}`}
                  onFocus={() => setActive(2)}
                >
                  <FormCardHead index={2} />
                  <div className="field-grid">
                    <Field
                      id="declaredAnnualIncome"
                      label="Annual household income (₹)"
                      placeholder="e.g. 96000"
                      type="number"
                      min={0}
                      required
                    />
                    <Field
                      id="declaredFamilySize"
                      label="Family size"
                      placeholder="People in the household"
                      type="number"
                      min={1}
                      max={30}
                      hint="Income is compared per person, not per household."
                      required
                    />
                  </div>
                </fieldset>

                <fieldset
                  ref={(el) => {
                    sectionRefs.current[3] = el;
                  }}
                  className={`card form-card${active === 3 ? ' is-active' : ''}`}
                  onFocus={() => setActive(3)}
                >
                  <FormCardHead index={3} />
                  <div className="field-grid">
                    <Field id="certificateId" label="Certificate number" placeholder="TN-CHN-2026-000000" />
                    <Field id="issuingOffice" label="Issuing office" placeholder="Taluk office" />
                    <Field id="certificateIssueDate" label="Issue date" type="date" />

                    <div className="field is-wide">
                      <span className="field-label">Income certificate</span>
                      <label className={`dropzone${fileName ? ' has-file' : ''}`} htmlFor="certificate">
                        <span className="dropzone-icon">{fileName ? <CheckIcon /> : <UploadIcon />}</span>
                        <span>
                          <span className="dropzone-title">{fileName ?? 'Choose a PDF or image'}</span>
                          <span className="dropzone-hint">
                            {fileName ? 'Click to replace' : 'Synthetic documents only · up to 12 MB'}
                          </span>
                        </span>
                        <input
                          id="certificate"
                          name="certificate"
                          type="file"
                          accept=".pdf,image/*"
                          className="visually-hidden"
                          onChange={(event) => setFileName(event.target.files?.[0]?.name ?? null)}
                        />
                      </label>
                    </div>
                  </div>
                </fieldset>

                <div className="card submit-bar">
                  <p>
                    Submitting records a declaration. Knowingly false declarations are a criminal
                    offence under Indian law.
                  </p>
                  <button type="submit" className="btn btn-primary">
                    Submit application
                    <ArrowIcon />
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

function FormCardHead({ index }: { index: number }) {
  const section = SECTIONS[index]!;
  return (
    <legend className="form-card-head">
      <span className="form-card-num">{String(index + 1).padStart(2, '0')}</span>
      <span>
        <span className="form-card-title">{section.title}</span>
        <span className="form-card-hint">{section.hint}</span>
      </span>
    </legend>
  );
}

interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
  hint?: string;
  wide?: boolean;
}

function Field({ id, label, hint, wide, required, ...input }: FieldProps) {
  return (
    <div className={`field${wide ? ' is-wide' : ''}`}>
      <label className="field-label" htmlFor={id}>
        {label}
        {required ? <span className="field-required" aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={id}
        name={id}
        className="input"
        required={required}
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...input}
      />
      {hint ? (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
