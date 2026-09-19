'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

/** Column order the API's CSV import reads. Keep in step with rowSchema in routes/admin.ts. */
const COLUMNS = [
  'email',
  'applicantName',
  'guardianName',
  'guardianPhone',
  'addressLine',
  'district',
  'pincode',
  'declaredAnnualIncome',
  'declaredFamilySize',
  'certificateId',
  'issuingOffice',
  'certificateIssueDate',
];

const TEMPLATE = `${COLUMNS.join(',')}\nstudent@example.com,Priya Ramesh,Ramesh Krishnan,9500011122,"22 Gandhi Road, Hasthampatti",Salem,636007,180000,4,TN-SLM-2026-100200,Taluk Office Salem,2026-05-10\n`;

interface ImportResult {
  imported: number;
  cycle: string;
  households: number;
  flagsWritten: number;
}

/**
 * Bulk intake. The API validates the whole file before writing any of it, so
 * a refusal means nothing was imported — which this says, rather than leaving
 * an admin to wonder which rows made it.
 */
export function ImportForm({ defaultCycle }: { defaultCycle: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError(null);
    setResult(null);

    const res = await fetch('/api/proxy/admin/import', { method: 'POST', body: new FormData(form) }).catch(() => null);
    const body = (await res?.json().catch(() => ({}))) as
      | (Partial<ImportResult> & { message?: string; details?: unknown })
      | undefined;
    setBusy(false);

    if (!res?.ok) {
      const details = body?.details ? ` ${JSON.stringify(body.details).slice(0, 300)}` : '';
      setError(`${body?.message ?? 'The import failed.'}${details} Nothing was imported.`);
      return;
    }
    form.reset();
    setResult(body as ImportResult);
    router.refresh();
  }

  return (
    <form className="inline-form" onSubmit={onSubmit}>
      <div className="field">
        <label className="field-label" htmlFor="import-file">
          CSV file
        </label>
        <input id="import-file" name="file" type="file" accept=".csv,text/csv" className="input file-input" required />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="import-cycle">
          Cycle
        </label>
        <input
          id="import-cycle"
          name="cycle"
          className="input"
          defaultValue={defaultCycle}
          inputMode="numeric"
          pattern="\d{4}"
          maxLength={4}
          required
        />
      </div>
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? 'Importing…' : 'Import'}
      </button>
      <p className="field-hint inline-form-full">
        One application per row, with a header row.{' '}
        <a className="text-link" href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`} download="scholarshield-import-template.csv">
          Download the template
        </a>
        . Imported rows have no certificate, so only the cross-application checks apply to them.
      </p>

      {error ? (
        <p className="auth-error inline-form-full" role="alert">
          {error}
        </p>
      ) : null}
      {result ? (
        <p className="auth-note inline-form-full" role="status">
          Imported {result.imported} application{result.imported === 1 ? '' : 's'} into {result.cycle}. The cycle
          was re-resolved into {result.households} households and rescored ({result.flagsWritten} flags).
        </p>
      ) : null}
    </form>
  );
}
