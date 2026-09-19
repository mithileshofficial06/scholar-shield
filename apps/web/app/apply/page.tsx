'use client';

import Link from 'next/link';
import { createContext, useContext, useRef, useState, type FormEvent } from 'react';
import { ArrowIcon, CheckIcon, LockIcon, UploadIcon, AlertIcon, DatabaseIcon } from '../components/Icons';

/**
 * Applicant submission.
 *
 * Fields are grouped by what consumes them downstream rather than by what is
 * convenient to type: the identity block is what the household resolver matches
 * on, the assessment block is what the scoring engine reads.
 *
 * Posts straight from the browser to the API rather than through this origin's
 * proxy. Submission is public (the applicant has no session yet), and the API's
 * per-address rate limit only means something if it sees the applicant's own
 * address — behind a proxy every applicant would share one bucket. CORS on the
 * API admits this origin and nothing else.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** What the API returns on submission — applicant-safe fields only. */
interface Submitted {
  id: string;
  cycle: string;
  stage: string;
  submittedAt: string;
  documentCount: number;
}

type FieldErrors = Partial<Record<string, string[]>>;

/** The API's per-field messages, keyed by field id, from the last refused submission. */
const FieldErrorsContext = createContext<FieldErrors>({});

const SECTIONS = [
  { title: 'Identity', hint: 'Who is applying, and their guardian' },
  { title: 'Residence', hint: 'Where the household lives' },
  { title: 'Assessment', hint: 'Declared income and family size' },
  { title: 'Certificate', hint: 'The income certificate itself' },
];

export default function ApplyPage() {
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
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

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    const data = new FormData(event.currentTarget);
    // An empty file input still submits a zero-byte part, which the API would
    // sniff, fail to recognise, and refuse as an unsupported type.
    const file = data.get('certificate');
    if (file instanceof File && file.size === 0) data.delete('certificate');

    let res: Response;
    try {
      res = await fetch(`${API_URL}/applications`, { method: 'POST', body: data });
    } catch {
      setError('The application service is not responding. Nothing was submitted — try again shortly.');
      setBusy(false);
      return;
    }

    const body = (await res.json().catch(() => ({}))) as Partial<Submitted> & {
      message?: string;
      details?: FieldErrors;
    };

    if (!res.ok) {
      setFieldErrors(body.details ?? {});
      setError(
        res.status === 400
          ? 'Some fields need attention — see the messages below each one.'
          : (body.message ?? 'Submission failed. Nothing was saved.'),
      );
      setBusy(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    setSubmitted(body as Submitted);
    setBusy(false);
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
                <h2>Application submitted</h2>
                <p>
                  Your application for the {submitted.cycle} cycle has been received
                  {submitted.documentCount > 0 ? ' along with your certificate' : ''}. The committee
                  will review it; you&rsquo;ll see the decision once review is complete.
                </p>
                <p>
                  Reference <strong className="tabular">{submitted.id}</strong>
                </p>
                <p>
                  To check progress later, request a sign-in link with the email address you used.
                </p>
                <div className="success-actions">
                  <Link href="/status" className="btn btn-primary">
                    Check application status
                    <ArrowIcon />
                  </Link>
                  <Link href="/" className="btn btn-ghost">
                    Return to overview
                  </Link>
                </div>
              </div>
            ) : (
              <FieldErrorsContext.Provider value={fieldErrors}>
                <form className="apply-form" onSubmit={onSubmit} onInput={recompute}>
                  {error ? (
                    <p className="auth-error" role="alert">
                      {error}
                    </p>
                  ) : null}

                  <fieldset
                    ref={(el) => {
                      sectionRefs.current[0] = el;
                    }}
                    className={`card form-card${active === 0 ? ' is-active' : ''}`}
                    onFocus={() => setActive(0)}
                  >
                    <FormCardHead index={0} />
                    <div className="field-grid">
                      <Field
                        id="applicantName"
                        label="Applicant full name"
                        placeholder="As printed on the certificate"
                        required
                      />
                      <Field
                        id="email"
                        label="Email"
                        type="email"
                        placeholder="you@example.com"
                        autoComplete="email"
                        hint="Where your sign-in link to check the application is sent."
                        required
                      />
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
                    <button type="submit" className="btn btn-primary" disabled={busy}>
                      {busy ? 'Submitting…' : 'Submit application'}
                      {busy ? null : <ArrowIcon />}
                    </button>
                  </div>
                </form>
              </FieldErrorsContext.Provider>
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
  const error = useContext(FieldErrorsContext)[id]?.[0];
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ');
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
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...input}
      />
      {hint ? (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="field-error" id={`${id}-error`}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
