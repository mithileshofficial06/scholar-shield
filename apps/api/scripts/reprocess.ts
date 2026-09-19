/**
 * Re-read every stored certificate, then rescore.
 *
 *   npm run reprocess                 every cycle
 *   npm run reprocess -- --cycle 2026 one cycle
 *
 * For after a change to what the pipeline records or the rules read. Documents
 * processed before the OCR report and the ela_applied flag existed carry
 * neither, so their figures-versus-words and tamper checks read as "not
 * checked" and the rules that need them cannot fire; a new rule version
 * otherwise waits for the next upload in each household to take effect.
 *
 * Runs OCR and forensics through the same stage functions as the worker, then
 * rescores each cycle once — not per document, since every rescore covers the
 * whole cycle anyway. The verification stage is not re-run: it only creates a
 * link once, and must not touch a result a reviewer has recorded. Purged
 * documents are skipped; there are no bytes left to read, which is the point.
 */

import { closePool, query } from '../src/db.js';
import { rescoreCycle } from '../src/routes/applications.js';
import { forensicsAnalyze, ocrExtract } from '../src/pipeline/stages.js';
import { defaultContext } from '../src/pipeline/worker.js';

const cycleFlag = process.argv.indexOf('--cycle');
const onlyCycle = cycleFlag >= 0 ? process.argv[cycleFlag + 1] : undefined;

async function main() {
  const { rows: documents } = await query<{ id: string; cycle: string }>(
    `SELECT d.id, a.cycle
       FROM documents d JOIN applications a ON a.id = d.application_id
      WHERE d.purged_at IS NULL ${onlyCycle ? 'AND a.cycle = $1' : ''}
      ORDER BY d.created_at`,
    onlyCycle ? [onlyCycle] : [],
  );

  let failed = 0;
  for (const [index, document] of documents.entries()) {
    try {
      await ocrExtract(document.id, defaultContext);
      await forensicsAnalyze(document.id, defaultContext);
      console.log(`read     ${index + 1}/${documents.length}  ${document.id}`);
    } catch (err) {
      failed += 1;
      console.warn(`failed   ${index + 1}/${documents.length}  ${document.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  const { rows: cycles } = await query<{ cycle: string }>(
    `SELECT DISTINCT cycle FROM applications ${onlyCycle ? 'WHERE cycle = $1' : ''} ORDER BY cycle`,
    onlyCycle ? [onlyCycle] : [],
  );
  for (const { cycle } of cycles) {
    const { scored } = await rescoreCycle(cycle, null);
    console.log(`rescored cycle ${cycle}: ${scored.scored.length} applications, ${scored.flagsWritten} flags`);
  }

  console.log(`${documents.length - failed} documents re-read, ${failed} failed`);
  await closePool();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});
