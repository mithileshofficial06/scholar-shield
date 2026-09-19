import type { ApplicantApplicationView } from '@scholarshield/shared';
import Link from 'next/link';

import { CheckIcon, DatabaseIcon } from '../components/Icons';

type Stage = ApplicantApplicationView['stage'];

const STAGES: { key: Stage; label: string }[] = [
  { key: 'submitted', label: 'Received' },
  { key: 'under_review', label: 'Under review' },
  { key: 'decided', label: 'Decided' },
];

const DESCRIBE: Record<Stage, string> = {
  submitted: 'Your application and certificate are being processed.',
  under_review: 'A committee member will review your application.',
  // Worded not to promise finality: the API folds escalation into this stage too,
  // so that approval, rejection and escalation read identically here.
  decided: 'A reviewer has acted on your application. The committee will contact you with the outcome.',
};

/**
 * An applicant's own applications, by coarse stage.
 *
 * The three stages are all the API reveals, on purpose: an internal status such
 * as "escalated" would tell an applicant that something about them drew
 * attention, which is exactly what a flag is not allowed to do.
 */
export function StageList({ applications }: { applications: ApplicantApplicationView[] }) {
  return (
    <div className="card auth-card status-card">
      <span className="auth-icon">
        <DatabaseIcon />
      </span>
      <h1>Your applications</h1>

      {applications.length === 0 ? (
        <>
          <p className="auth-lede">There is no application filed under this email yet.</p>
          <Link href="/apply" className="btn btn-primary auth-submit">
            Start an application
          </Link>
        </>
      ) : (
        <ul className="status-list">
          {applications.map((app) => {
            const reached = STAGES.findIndex((s) => s.key === app.stage);
            return (
              <li key={app.id} className="status-item">
                <p className="status-meta">
                  <span>{app.cycle} cycle</span>
                  <span className="tabular">
                    Submitted {new Date(app.submittedAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}
                  </span>
                </p>
                <ol className="status-steps" aria-label="Progress">
                  {STAGES.map((stage, index) => (
                    <li
                      key={stage.key}
                      className={`status-step${index <= reached ? ' is-done' : ''}`}
                      aria-current={index === reached ? 'step' : undefined}
                    >
                      <span className="status-dot">{index <= reached ? <CheckIcon /> : index + 1}</span>
                      {stage.label}
                    </li>
                  ))}
                </ol>
                <p className="status-desc">{DESCRIBE[app.stage]}</p>
                <p className="status-ref tabular">Ref {app.id}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
