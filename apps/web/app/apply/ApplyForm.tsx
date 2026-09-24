'use client';

import type { ApplicantApplicationView } from '@scholarshield/shared';
import Link from 'next/link';
import { createContext, useContext, useEffect, useRef, useState, type FormEvent } from 'react';
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
  /** A first submission from this address: review waits until the emailed link is used. */
  confirmationRequired?: boolean;
  /** Local development only, when no mail server is configured. */
  devToken?: string;
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

/*
 * A refresh must not throw away the applicant's work. The draft and, once sent,
 * the receipt are kept in sessionStorage: per tab, gone when the tab closes, and
 * never sent anywhere. The certificate file cannot be kept — browsers do not let
 * a page refill a file input — so it is the one field a refresh loses.
 */
const DRAFT_KEY = 'ss_apply_draft';
const RECEIPT_KEY = 'ss_apply_receipt';

function readStored<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function store(key: string, value: unknown | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked (private mode, disabled site data): the form still works,
    // it just cannot survive a refresh.
  }
}

/** Every named text-like field in the form, keyed by name. The file input is skipped. */
function draftOf(form: HTMLFormElement): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const input of Array.from(form.querySelectorAll<HTMLInputElement>('input[name]'))) {
    if (input.type !== 'file' && input.value !== '') draft[input.name] = input.value;
  }
  return draft;
}

const STAGE_LABEL: Record<ApplicantApplicationView['stage'], string> = {
  submitted: 'Received',
  under_review: 'Under review',
  decided: 'Decided',
};

/**
 * @param existing The signed-in applicant's applications, read on the server.
 *   Empty when nobody is signed in — a signed-out visitor is not asked who they are.
 */
export function ApplyForm({ existing }: { existing: ApplicantApplicationView[] }) {
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  // A signed-in applicant who already applied sees that application first; the
  // blank form is one deliberate click away, for a sibling applying on the same
  // account. The API refuses a second application for the same person anyway.
  const [applyingForAnother, setApplyingForAnother] = useState(false);
  const [alreadyApplied, setAlreadyApplied] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [active, setActive] = useState(0);
  const [complete, setComplete] = useState<boolean[]>(SECTIONS.map(() => false));
  const [fileName, setFileName] = useState<string | null>(null);
  const sectionRefs = useRef<(HTMLFieldSetElement | null)[]>([]);
  const errorRef = useRef<HTMLParagraphElement>(null);

  /** A section is complete once every required field in it has a value. */
  const recompute = () => {
    setComplete(
      sectionRefs.current.map((fieldset) => {
        if (!fieldset) return false;
        const fields = Array.from(fieldset.querySelectorAll<HTMLInputElement>('input'));
        const required = fields.filter((f) => f.required || f.dataset.required === 'true');
        const pool = required.length > 0 ? required : fields;
        return required.length > 0 ? pool.every((f) => f.value.trim() !== '') : pool.some((f) => f.value.trim() !== '');
      }),
    );
  };

  // Restore after a refresh. Runs once, after hydration, because sessionStorage
  // does not exist on the server that rendered the first paint.
  useEffect(() => {
    const receipt = readStored<Submitted>(RECEIPT_KEY);
    if (receipt) {
      setSubmitted(receipt);
      return;
    }
    const draft = readStored<Record<string, string>>(DRAFT_KEY);
    const form = formRef.current;
    if (!draft || !form) return;
    for (const [name, value] of Object.entries(draft)) {
      const input = form.elements.namedItem(name);
      if (input instanceof HTMLInputElement && input.type !== 'file') input.value = value;
    }
    recompute();
    // recompute reads the DOM, not state, so it is safe to leave out of the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyingForAnother]);

  const onInput = () => {
    recompute();
    if (formRef.current) store(DRAFT_KEY, draftOf(formRef.current));
  };

  const startAnother = () => {
    store(RECEIPT_KEY, null);
    store(DRAFT_KEY, null);
    setSubmitted(null);
    setError(null);
    setFieldErrors({});
    setAlreadyApplied(false);
    setFileName(null);
    setComplete(SECTIONS.map(() => false));
    setApplyingForAnother(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    setAlreadyApplied(false);

    const data = new FormData(event.currentTarget);
    // An empty file input still submits a zero-byte part. The API accepts an
    // application without a certificate (a spreadsheet import has none), but an
    // applicant's must carry one: every document check reads it.
    const file = data.get('certificate');
    if (!(file instanceof File) || file.size === 0) {
      setFieldErrors({ certificate: ['Upload your income certificate. The document checks cannot run without it.'] });
      setError('Some fields need attention — see the messages below each one.');
      setBusy(false);
      // Straight to the drop zone: the banner is sections away from the problem.
      requestAnimationFrame(() =>
        document.getElementById('certificate-error')?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      );
      return;
    }

    let res: Response;
    try {
      res = await fetch(`${API_URL}/applications`, { method: 'POST', body: data });
    } catch {
      setError('The application service is not responding. Nothing was submitted — try again shortly.');
      setBusy(false);
      return;
    }

    const body = (await res.json().catch(() => ({}))) as Partial<Submitted> & {
      error?: string;
      message?: string;
      details?: FieldErrors;
    };

    if (!res.ok) {
      setAlreadyApplied(body.error === 'already_applied');
      setFieldErrors(body.details ?? {});
      setError(
        res.status === 400
          ? 'Some fields need attention — see the messages below each one.'
          : (body.message ?? 'Submission failed. Nothing was saved.'),
      );
      setBusy(false);
      // The banner renders on the next paint; scroll to it rather than to the
      // page top, which sits above the form and would hide it again.
      requestAnimationFrame(() => errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      return;
    }

    setSubmitted(body as Submitted);
    store(RECEIPT_KEY, body);
    store(DRAFT_KEY, null);
    setBusy(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const doneCount = complete.filter(Boolean).length;
  const showingForm = !submitted && (existing.length === 0 || applyingForAnother);

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
            {showingForm ? (
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
            ) : null}

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

          <div className="apply-main">
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
                {submitted.confirmationRequired ? (
                  <p role="status">
                    <strong>One more step:</strong> we have emailed you a link. Open it to confirm the
                    address is yours &mdash; your application is not reviewed until you do.
                    {submitted.devToken ? (
                      <>
                        {' '}
                        (Development: no mail server is configured, so{' '}
                        <Link href={`/status?token=${encodeURIComponent(submitted.devToken)}`}>
                          confirm here
                        </Link>
                        .)
                      </>
                    ) : null}
                  </p>
                ) : null}
                <p>
                  To check progress later, request a sign-in link with the email address you used.
                </p>
                <div className="success-actions">
                  <Link href="/status" className="btn btn-primary">
                    Check application status
                    <ArrowIcon />
                  </Link>
                  <button type="button" className="btn btn-ghost" onClick={startAnother}>
                    Apply for another family member
                  </button>
                </div>
              </div>
            ) : existing.length > 0 && !applyingForAnother ? (
              <div className="card success-card">
                <span className="success-icon">
                  <CheckIcon />
                </span>
                <h2>You&rsquo;ve already applied</h2>
                <p>Your application is saved. There is no need to fill in the form again.</p>
                <ul className="existing-list">
                  {existing.map((app) => (
                    <li key={app.id}>
                      <span>
                        {app.cycle} cycle · submitted{' '}
                        {new Date(app.submittedAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}
                      </span>
                      <strong>{STAGE_LABEL[app.stage]}</strong>
                    </li>
                  ))}
                </ul>
                <div className="success-actions">
                  <Link href="/status" className="btn btn-primary">
                    View application status
                    <ArrowIcon />
                  </Link>
                  <button type="button" className="btn btn-ghost" onClick={() => setApplyingForAnother(true)}>
                    Apply for another family member
                  </button>
                </div>
              </div>
            ) : (
              <FieldErrorsContext.Provider value={fieldErrors}>
                <form ref={formRef} className="apply-form" onSubmit={onSubmit} onInput={onInput}>
                  {error ? (
                    <p className="auth-error" role="alert" ref={errorRef}>
                      {error}
                      {alreadyApplied ? (
                        <>
                          {' '}
                          <Link href="/status">Check its status</Link>
                        </>
                      ) : null}
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
                        <span className="field-label">
                          Income certificate<span className="field-required" aria-hidden="true"> *</span>
                        </span>
                        <label
                          className={`dropzone${fileName ? ' has-file' : ''}${fieldErrors.certificate ? ' is-invalid' : ''}`}
                          htmlFor="certificate"
                        >
                          <span className="dropzone-icon">{fileName ? <CheckIcon /> : <UploadIcon />}</span>
                          <span>
                            <span className="dropzone-title">{fileName ?? 'Choose a PDF or image'}</span>
                            <span className="dropzone-hint">
                              {fileName ? 'Click to replace' : 'JPEG, PNG, WebP or PDF · up to 12 MB · synthetic documents only'}
                            </span>
                          </span>
                          {/*
                            Required, but checked in onSubmit rather than with the
                            `required` attribute: the input is visually hidden behind
                            the drop zone, and the browser's own "please select a
                            file" bubble would point at a 1px element.
                          */}
                          <input
                            id="certificate"
                            name="certificate"
                            type="file"
                            accept=".pdf,image/*"
                            className="visually-hidden"
                            data-required="true"
                            aria-invalid={fieldErrors.certificate ? true : undefined}
                            aria-describedby={fieldErrors.certificate ? 'certificate-error' : undefined}
                            onChange={(event) => {
                              setFileName(event.target.files?.[0]?.name ?? null);
                              setFieldErrors(({ certificate: _cleared, ...rest }) => rest);
                            }}
                          />
                        </label>
                        {fieldErrors.certificate ? (
                          <span className="field-error" id="certificate-error">
                            {fieldErrors.certificate[0]}
                          </span>
                        ) : (
                          <span className="field-hint">
                            Every document check — whose certificate it is, the income on it, the government
                            record — reads this file.
                          </span>
                        )}
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
