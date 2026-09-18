'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

interface Props {
  rules: { ruleId: string; count: number }[];
  districts: string[];
  cycles: string[];
  total: number;
}

/**
 * Queue filters.
 *
 * State lives in the URL rather than in component state, so a reviewer can
 * bookmark "high severity in Coimbatore" and hand the link to a colleague, and
 * the back button behaves. The server component re-runs on every change, which
 * keeps the count honest — it is the database's answer, not a filtered array.
 */
export function QueueFilters({ rules, districts, cycles, total }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const [search, setSearch] = useState(params.get('q') ?? '');

  // Debounced: a keystroke per request would put the queue behind the typing.
  useEffect(() => {
    const current = params.get('q') ?? '';
    if (search === current) return;
    const timer = setTimeout(() => update('q', search), 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  function update(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value && value !== 'any' && value !== 'all') next.set(key, value);
    else next.delete(key);
    // A filter change moves you to the first page; staying on page 4 of a
    // narrower result set shows an empty table and looks like a bug.
    next.delete('offset');
    startTransition(() => router.replace(`${pathname}?${next.toString()}`));
  }

  const severity = params.get('severity') ?? 'any';
  const status = params.get('status') ?? 'awaiting';
  const cycle = params.get('cycle') ?? '';
  const district = params.get('district') ?? '';
  const ruleId = params.get('ruleId') ?? '';
  const active = ['severity', 'status', 'cycle', 'district', 'ruleId', 'q'].filter(
    (key) => params.get(key) && params.get(key) !== 'awaiting',
  ).length;

  return (
    <div className={`filters card${pending ? ' is-pending' : ''}`}>
      <div className="filter-row">
        <div className="filter search-filter">
          <label className="filter-label" htmlFor="q">
            Search
          </label>
          <input
            id="q"
            className="input"
            placeholder="Applicant, guardian or certificate number"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <Select id="status" label="Status" value={status} onChange={update}
          options={[
            ['awaiting', 'Awaiting review'],
            ['decided', 'Decided'],
            ['all', 'All'],
          ]}
        />

        <Select id="severity" label="Severity" value={severity} onChange={update}
          options={[
            ['any', 'Any'],
            ['high', 'High'],
            ['medium', 'Medium'],
            ['low', 'Low'],
          ]}
        />

        <Select id="cycle" label="Cycle" value={cycle} onChange={update}
          options={[['', 'All cycles'], ...cycles.map((c) => [c, c] as [string, string])]}
        />

        <Select id="district" label="District" value={district} onChange={update}
          options={[['', 'All districts'], ...districts.map((d) => [d, d] as [string, string])]}
        />

        <Select id="ruleId" label="Rule fired" value={ruleId} onChange={update}
          options={[
            ['', 'Any rule'],
            ...rules.map((r) => [r.ruleId, `${r.ruleId.replaceAll('_', ' ').toLowerCase()} (${r.count})`] as [string, string]),
          ]}
        />
      </div>

      <div className="filter-foot">
        <span className="filter-count">
          {pending ? 'Filtering…' : `${total} application${total === 1 ? '' : 's'}`}
          {active > 0 ? ` · ${active} filter${active === 1 ? '' : 's'} applied` : ''}
        </span>

        <div className="filter-actions">
          {active > 0 ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => startTransition(() => router.replace(pathname))}>
              Clear filters
            </button>
          ) : null}
          <a className="btn btn-ghost btn-sm" href={`/api/proxy/queue/export.csv?${params.toString()}`}>
            Export CSV
          </a>
        </div>
      </div>
    </div>
  );
}

function Select({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: [string, string][];
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="filter">
      <label className="filter-label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="input select" value={value} onChange={(event) => onChange(id, event.target.value)}>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </div>
  );
}
