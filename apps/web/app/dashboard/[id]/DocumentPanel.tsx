'use client';

import type { DocumentSummary } from '@scholarshield/shared';
import { useState } from 'react';

/**
 * The submitted certificate, and what OCR made of it.
 *
 * The image is fetched through a short-lived signed URL requested on demand
 * rather than embedded in the page, so a link copied out of the HTML is useless
 * within minutes — and a purged document says so instead of showing a broken
 * frame.
 *
 * Every extracted value carries its confidence because roughly one document in
 * three has at least one misread field. A number shown without that is a number
 * a reviewer will trust more than it deserves.
 */
export function DocumentPanel({ document }: { document: DocumentSummary }) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'purged' | 'error'>('idle');

  async function open() {
    setState('loading');
    const res = await fetch(`/api/proxy/documents/${document.id}/url`);
    if (res.status === 410) {
      setState('purged');
      return;
    }
    if (!res.ok) {
      setState('error');
      return;
    }
    const payload = (await res.json()) as { url: string };
    setUrl(payload.url);
    setState('idle');
  }

  const fields = Object.entries(document.extractedFields ?? {});

  return (
    <div className="document-panel">
      <div className="document-head">
        <div>
          <p className="document-name">
            {document.kind === 'income_certificate' ? 'Income certificate' : 'Supporting document'}
          </p>
          <p className="document-meta data">
            {document.contentType} · {(document.byteSize / 1024).toFixed(0)} KB · sha256{' '}
            {document.sha256.slice(0, 12)}…
          </p>
        </div>
        {document.purgedAt ? (
          <span className="sev-pill sev-medium">purged</span>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={open} disabled={state === 'loading'}>
            {state === 'loading' ? 'Opening…' : url ? 'Refresh link' : 'View document'}
          </button>
        )}
      </div>

      {state === 'purged' ? (
        <p className="document-note">
          Purged under the retention policy. Its hash remains in the audit log, so the decision is
          still traceable to this exact file.
        </p>
      ) : null}
      {state === 'error' ? <p className="document-note">The document could not be opened.</p> : null}

      {url ? (
        <div className="document-frame">
          {document.contentType === 'application/pdf' ? (
            <object data={url} type="application/pdf" aria-label="Submitted certificate">
              <a href={url} target="_blank" rel="noreferrer">
                Open the PDF
              </a>
            </object>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt="Submitted income certificate" />
          )}
          <p className="document-note">This link expires in five minutes.</p>
        </div>
      ) : null}

      {fields.length > 0 ? (
        <table className="extract-table">
          <thead>
            <tr>
              <th scope="col">Field read from the document</th>
              <th scope="col">Value</th>
              <th scope="col">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {fields.map(([name, field]) => {
              const confidence = Math.round(field.confidence * 100);
              const tone = confidence >= 80 ? 'low' : confidence >= 50 ? 'medium' : 'high';
              return (
                <tr key={name}>
                  <td>{name.replaceAll('_', ' ')}</td>
                  <td className={field.value ? 'data' : 'muted'}>{field.value ?? 'not read'}</td>
                  <td>
                    <span className={`sev-pill sev-${tone}`}>{confidence}%</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="document-note">
          {document.purgedAt
            ? 'Extracted fields were deleted with the document.'
            : 'No fields extracted yet — the pipeline may still be running.'}
        </p>
      )}
    </div>
  );
}
