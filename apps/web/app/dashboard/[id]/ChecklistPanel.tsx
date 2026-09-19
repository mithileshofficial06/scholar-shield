import type { ApplicationCheck, ApplicationChecklist, CheckGroup, CheckStatus } from '@scholarshield/shared';

import { CheckIcon, CrossIcon } from '../../components/Icons';

const GROUPS: { key: CheckGroup; title: string; hint: string }[] = [
  { key: 'document', title: 'The document', hint: 'Was a certificate uploaded, read, and left unedited?' },
  { key: 'certificate', title: 'Certificate against the form', hint: 'Does the certificate say what the applicant declared?' },
  { key: 'government', title: 'Government record', hint: 'Does the state portal know this certificate?' },
  { key: 'household', title: 'Against other applications', hint: 'Does anything else in the cycle contradict it?' },
];

const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: 'Passed',
  fail: 'Failed',
  skipped: 'Not checked',
  pending: 'Pending',
};

/**
 * Every check the engine runs on this application, with its outcome.
 *
 * The flag list above says what fired. This says everything else a reviewer
 * needs before trusting the absence of a flag: what was checked and held, what
 * could not be checked and why, and what is still waiting — including on them.
 */
export function ChecklistPanel({ checklist }: { checklist: ApplicationChecklist }) {
  const { summary } = checklist;
  return (
    <div className="checklist">
      <p className="checklist-summary">
        {(['fail', 'pending', 'skipped', 'pass'] as const).map((status) => (
          <span key={status} className={`check-count is-${status}`}>
            <strong className="tabular">{summary[status]}</strong> {STATUS_LABEL[status].toLowerCase()}
          </span>
        ))}
        <span className="checklist-version">rules {checklist.configVersion}</span>
      </p>

      {GROUPS.map((group) => {
        const checks = checklist.checks.filter((c) => c.group === group.key);
        if (checks.length === 0) return null;
        return (
          <section key={group.key} className="check-group">
            <h3>
              {group.title}
              <span>{group.hint}</span>
            </h3>
            <ul>
              {checks.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function CheckRow({ check }: { check: ApplicationCheck }) {
  const compared = check.declared !== undefined || check.certificate !== undefined;
  return (
    <li className={`check is-${check.status}`}>
      <span className={`check-badge is-${check.status}`} aria-label={STATUS_LABEL[check.status]}>
        {check.status === 'pass' ? <CheckIcon /> : check.status === 'fail' ? <CrossIcon /> : check.status === 'pending' ? '…' : '–'}
      </span>
      <div className="check-body">
        <p className="check-label">
          {check.label}
          <span className={`check-state is-${check.status}`}>{STATUS_LABEL[check.status]}</span>
          {check.status === 'fail' && check.severity ? (
            <span className={`sev-pill sev-${check.severity}`}>{check.severity}</span>
          ) : null}
        </p>
        {compared && (check.declared || check.certificate) ? (
          <dl className="check-compare">
            <div>
              <dt>{check.id === 'certificate.income_words' ? 'In figures' : 'Form'}</dt>
              <dd className="data">{check.declared ?? '—'}</dd>
            </div>
            <div>
              <dt>{check.id === 'certificate.income_words' ? 'In words' : 'Certificate'}</dt>
              <dd className="data">{check.certificate ?? '—'}</dd>
            </div>
          </dl>
        ) : null}
        <p className="check-detail">{check.detail}</p>
        {check.ruleId ? <p className="check-rule data">{check.ruleId}</p> : null}
      </div>
    </li>
  );
}
