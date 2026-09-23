# scholar-shield

**Scholarship fraud risk-triage for college committees.** An entity-resolution and contradiction-detection engine over scholarship applications, with document forensics as a secondary signal and a human decision required at every exit.

> ScholarShield flags applications for **review order**. It does not approve, reject, or accuse anyone. There is no code path by which the system decides an outcome.

---

## Contents

- [The problem](#the-problem) · [How it works](#how-it-works) · [Design principles](#design-principles)
- [The rules](#the-rules) · [What a reviewer sees](#what-a-reviewer-sees) · [Deciding](#deciding)
- [Validation](#validation) · [Metrics](#metrics) · [Equity](#equity)
- [Security model](#security-model) · [Repository layout](#repository-layout)
- [Run the whole thing](#run-the-whole-thing) · [Develop against it](#develop-against-it) · [Testing](#testing)
- [A five-minute walkthrough](#a-five-minute-walkthrough) · [Deploying it for real](#deploying-it-for-real)
- [Limitations](#limitations)

---

## The problem

Indian scholarship programs reserved for economically weaker students are routinely claimed using income certificates that declare a household income far below reality. Existing state portals answer *"was this certificate issued?"* — but the dominant fraud pattern is a certificate that **was** genuinely issued and still misrepresents the family's position.

Nothing available to a college cross-references applications **against each other**, which is where that pattern becomes visible: a sibling's separately filed application declaring a different household income, several "unrelated" low-income applicants at one address, the same guardian appearing with two incomes.

That cross-referencing is the core of this project. See [PROJECT_REPORT.md](./PROJECT_REPORT.md) for the full problem analysis, research citations, and design rationale.

## How it works

```
Applicant submits certificate + declared fields
        ↓
  1. OCR extraction           (Python/FastAPI — Tesseract)
  2. Document forensics       (Python/FastAPI — ELA + metadata)
  3. Certificate authenticity (pre-filled manual verification link)
  4. Household reconciliation (normalize → fuzzy resolve → components → contradiction rules)
  5. Explainable risk scoring (versioned weighted rules)
        ↓
Reviewer risk queue — sorted by score, every flag drillable into "why"
        ↓
Decision + typed reason → append-only audit log
```

**The core engine is step 4.** Identity fields are normalized, applications are entity-resolved against each other via Postgres `pg_trgm` similarity, connected components become candidate households, and contradiction rules run *within* and *across* those households.

Three properties of the pipeline are load-bearing and easy to get wrong:

- **Idempotent stages.** Every handler is keyed on `(document_id, stage)` with a `UNIQUE` constraint, and claims its row in a single `INSERT … ON CONFLICT DO UPDATE` before doing any work. BullMQ delivers at least once; a redelivered job must not double-write flags. Proven in `test/integration/idempotency.test.ts`, including eight concurrent deliveries collapsing to one execution.
- **Results persist per stage**, so a retry resumes from the failed stage rather than restarting from OCR — which matters because OCR is by far the most expensive step. Exhausted retries land in a dead-letter state surfaced in the admin UI, never failing silently.
- **The re-scoring fan-out.** When a new application joins a household, *every* application in that household is re-scored. A contradiction is a property of the family, not of one upload — a sibling declaring a different income makes both applications worth looking at, and the one already in the queue has to move.

## Design principles

1. **No automated verdicts.** Score changes queue position, nothing else.
2. **Manual verification is the primary path.** No government portal is ever scraped.
3. **Synthetic data only.** No real student's document is ingested at any point.
4. **Every decision is auditable.** Append-only log, typed reason required.
5. **Every flag is explainable.** No black-box model — reason string, rule ID, and config version on every flag.

## The rules

Twenty rules in three tiers, all in [`apps/api/src/household/rules.ts`](./apps/api/src/household/rules.ts). Weights live in `config/rules.v5.json` and are **stamped onto every flag**, so a score computed six months ago stays reproducible against the weights that produced it. A published config is never edited in place; changing a weight means adding a version.

An application reaching **50** is high severity. That threshold is what the tier weighting below is arranged around.

### Tier 1 — pairwise contradictions

One application against one other thing: a sibling, a guardian, its own certificate.

| Rule | Sev | Wt | Fires when |
|---|---|---|---|
| `GOVERNMENT_RECORD_MISMATCH` | high | 50 | A reviewer checked the state portal and recorded a mismatch. The only human-confirmed input, so the heaviest weight. |
| `DUPLICATE_CERTIFICATE_ID` | high | 45 | One certificate number used by two applications. No tolerance — a serial matches exactly or it doesn't. |
| `DECLARED_INCOME_BELOW_CERTIFICATE` | high | 45 | The applicant's own certificate reads materially higher than the form declares. Only *understatement* fires. |
| `SIBLING_INCOME_CONTRADICTION` | high | 40 | Two applications in one household declaring materially different incomes. Both sides flag — neither is presumptively honest. |
| `CERTIFICATE_HOLDER_MISMATCH` | high | 40 | The certificate names a different applicant or guardian than the form. |
| `DOCUMENT_NOT_A_CERTIFICATE` | high | 40 | The upload was read clearly and still carries fewer than 3 of the 8 fields a certificate has. |
| `GUARDIAN_INCOME_CONTRADICTION` | high | 35 | Same guardian, different households, different incomes — catches a resolution failure. |
| `CERTIFICATE_NUMBER_MISMATCH` | high | 30 | The uploaded certificate isn't the one whose number the applicant typed. |
| `CERTIFICATE_INCOME_WORDS_MISMATCH` | high | 30 | Figures and words disagree *on the certificate itself* — an edit to one line that missed the other. |
| `SHARED_CONTACT_UNRELATED_HOUSEHOLDS` | medium | 22 | One phone across households that never resolved together. |
| `ADDRESS_CLUSTER_UNRELATED` | medium | 20 | Three or more unrelated households at one address. Medium, not high — tenements and joint families are real. |
| `FAMILY_SIZE_CONTRADICTION` | medium | 18 | Family size disagrees across a household. A marriage or a death changes it legitimately. |
| `CERTIFICATE_DETAILS_MISMATCH` | medium | 15 | District, PIN or family size on the certificate disagree with the form. |
| `DOCUMENT_TAMPER_SIGNAL` | medium | 15 | The file's metadata names an image or PDF editor. **ELA is deliberately not scored** — see [Limitations](#limitations). |
| `ISSUING_OFFICE_MISMATCH` | low | 8 | Two offices across one household. A family that moved does this. |
| `DEADLINE_PROXIMITY` | low | 6 | Certificate obtained just before the deadline. **Never fires alone** — requires corroboration from a Tier 1 rule. |

### Tier 1b — population-level

Everything above compares an application against *one* other thing. Fraud visible only in the **shape of a population** produces no contradicting pair, so no pairwise rule can reach it. These read a whole cycle at once.

| Rule | Sev | Wt | Mechanism |
|---|---|---|---|
| `HOUSEHOLD_FRAGMENTATION` | medium | 28 | Deliberate identity fragmentation. Pairs scoring 0.38–0.55 on **two or more independent fields** — close on several axes, over the line on none, so no household rule ever compared them. Strangers match on nothing; this band is not where honest data lands. |
| `CERTIFICATE_SERIAL_ADJACENCY` | medium | 25 | Bulk issuance. An office issues serials in order as people arrive, so genuine certificates spread across a year. A tight run held by unrelated households is a block printed in one sitting. |
| `IDENTICAL_ROUND_INCOME_CLUSTER` | medium | 22 | Certificate mills. Identical **and** round **and** from one office — each alone is innocent; the combination is a stock figure rather than an assessed income. |
| `INCOME_THRESHOLD_BUNCHING` | low | 10 | Threshold gaming. The bunching estimator from public economics: a real population thins out towards a ceiling it cannot see, so a spike just below the line is figures *chosen* to qualify. |

Tier 1b carries two guarantees, both pinned by tests in `test/population.test.ts`:

- **No population rule can reach high severity alone.** All four firing at once still lands under the threshold.
- **They cannot satisfy another rule's corroboration requirement.** A bunching flag does not license `DEADLINE_PROXIMITY`. Two things that are individually not evidence must not add up to something that looks like it.

The reason is fairness, not caution. A population signal describes the company an applicant keeps — which they did not choose and cannot contest.

### Tier 2 — document forensics

Metadata and error-level analysis, via the Python service. **ELA contributes nothing**: measured at AUC 0.502 against matched controls, which is chance. Reported rather than quietly shipped.

### Cut

**Tier 4, the district income band, was never built.** It was first in the stated cut order and it is the one that was taken. Every shipped signal is therefore *relative* — to a sibling, to the applicant's own certificate, or to the rest of a cycle. A household that lies consistently, alone, in a district with few other applicants is not something this system can see.

## What a reviewer sees

Not a score with a list of complaints. The application detail page shows **every check that ran**, including the ones that passed and the ones that could not run, because a reviewer can only trust the absence of a flag if they can see which checks produced it.

Each check reports one of four states, and the distinction between the last two is the whole design:

| State | Means |
|---|---|
| `pass` | Ran, and found nothing. |
| `fail` | Ran, and found something. Carries the reason and the values that triggered it. |
| `pending` | Waiting on the pipeline, or on a person — e.g. the portal check nobody has recorded yet. |
| `skipped` | **Could not run.** OCR read the field below the confidence floor, or the applicant declared nothing to compare. |

**A field OCR was unsure of is skipped, never failed.** An unreadable word on an honest certificate must not read as a lie. That rule has a cost — a file that isn't a certificate at all produces the same wall of skips as a bad scan — which is why `DOCUMENT_NOT_A_CERTIFICATE` exists: it fails only on a page read *clearly* that still lacks a certificate's fields.

The household panel renders the resolved component as a graph, showing which field matched on each edge. A reviewer can **reject an edge**, splitting the household and re-scoring it. Entity resolution produces false merges; the remedy is that it is contestable, not that it is tuned until it isn't.

## Deciding

Four dispositions, each requiring a typed reason of at least 12 characters, each writing an append-only audit row with the reviewer's id. This is the only path to a terminal status — the score is not consulted and no branch reads it.

| | |
|---|---|
| **Approve** | Award the scholarship. Terminal. |
| **Escalate** | Send to a senior reviewer. **Not terminal** — someone still has to decide. |
| **Reject** | Refuse the application. Terminal. |
| **Trash** | Not a real application: random details, an unrelated file. Terminal. |

Trash exists because rejecting junk counts it as a refusal, which is what a committee reads its reject rate as, and it makes every real refusal harder to defend in an audit. Trashed applications leave the working queue, the decided list and the CSV export, but stay auditable under their own filter — and their documents are purged by the retention job like any other terminal state.

Applicants see a coarse stage (`submitted` → `under_review` → `decided`) and never learn which of the four it was.

## Validation

Most projects of this kind validate a rule engine against synthetic data generated to match its own detection patterns, which proves internal consistency and nothing else. Three mechanisms break that circularity:

- **Sealed holdout patterns** — `patterns.holdout.ts` is authored and committed *before any rule code exists*. Git history is the proof: `git log --diff-filter=A` shows it landing a day before `rules.ts`.
- **Document realism pipeline** — every generated certificate is degraded (rotation, perspective warp, illumination, noise, JPEG recompression) before OCR sees it.
- **Decoupled tamper generation** — tampering is produced through a different image path than the detector assumes, alongside untampered-but-recompressed controls that yield a *measured* ELA false-positive rate.

The corpus is split three ways, and the split is the point:

| Set | What recall against it means |
|---|---|
| `patterns.known.ts` | Internal consistency. A floor, not a result. Quoting it alone would be the circular claim the split exists to prevent. |
| `patterns.holdout.ts` | **Spent.** Was the honest number; see the accounting below and in `db/seed/holdout-status.ts`. |
| `patterns.sealed-v2.ts` | Pre-registered against mechanisms no rule targets. The clean number. |

### Metrics

Generated by `npm run metrics`, never hand-typed. All scoped to the synthetic corpus. If there is no local Python virtualenv, the document measurements run inside the `ocr-service` image, which carries the pinned Tesseract the numbers are meant to be reproducible against — and CI regenerates the corpus and fails if this table has gone stale.

<!-- METRICS:START -->

_Generated by `npm run metrics` on 2026-09-20. Never hand-edited._

| Metric | Value |
|---|---|
| Precision@10 | 100.0% (base rate 53.5%) |
| Queue lift (top decile vs. base rate) | 1.87× (top 4 of 43) |
| Holdout recall (first set — spent, see notes) | 70.6% (24/34) |
| Sealed-v2 recall (pre-registered, no rule targets it) | 30.0% (3/10) |
| Known recall | 100.0% (23/23) |
| ELA false-positive rate | 4.5% (1/22 controls) |
| ELA tampered-vs-control AUC | 0.502 (0.500 = chance) |
| OCR field accuracy (degraded corpus) | 91.7% (798/870) |
| OCR documents fully correct | 59/87 |
| Equity pass rate | 100.0% (9/9 cases) |

**The sealed holdout is spent, and 70.6% is no longer a clean generalisation number.** It was one at v3, when it read 38.2%. The data has not changed — `patterns.holdout.ts` is byte-identical and `git log --diff-filter=A` still shows it committed a day before any rule code. What changed is that the v3 metrics note *named the missing rule families*, and the v4 rules were written against those mechanisms. The sealed case data was never opened, and no threshold was chosen by checking what a case needed — but the decision about what to build was informed by this set's own results. That is leakage. It is the ordinary way a project learns from an evaluation, and it is still reported rather than absorbed.

Why no slice of it can be quoted instead: 4 cases are now explicitly targeted (`db/seed/holdout-status.ts`), and they are *exactly* the cases v3 missed. Recall over the remainder is therefore 100% by construction, which measures nothing at all. There is no honest sub-number left in this set.

Of the 4 mechanisms v4 now targets, 2 are caught and 2 are still missed *with a rule written for them* — kept visible because a rule that targets a mechanism and still fails to surface it is the more useful fact:

- `HO-02-threshold-bunching` → `INCOME_THRESHOLD_BUNCHING` (v4): **caught**. Threshold gaming. The rule compares the density of the band below the ceiling against the band below that, so it fires on the comparison rather than on any applicant being near the line.
- `HO-04-certificate-serial-adjacency` → `CERTIFICATE_SERIAL_ADJACENCY` (v4): **caught**. Bulk issuance. Same office, same serial series, tight numeric run, unrelated households.
- `HO-09-identical-round-income-mill` → `IDENTICAL_ROUND_INCOME_CLUSTER` (v4): **still missed**. Targeted but still missed. The rule requires the repeated round figure to come from ONE issuing office, which is the condition carrying its precision — dropping it would flag every district where many families honestly declare the same round number. A cross-office variant is a v5 candidate and must be validated against patterns.sealed-v2.ts, not against this case, which is now known.
- `HO-10-deliberate-household-split` → `HOUSEHOLD_FRAGMENTATION` (v4): **still missed**. Targeted but still missed. The rule fires on pairs scoring between 0.38 and the 0.55 link threshold on two or more independent fields; this split evidently clears neither condition. Loosening either from here would be tuning against a case whose answer is known.

**The next honest number requires a new sealed set.** `patterns.sealed-v2.ts` is authored against mechanisms no rule targets, and committed before any rule that might catch them. It carries a weaker claim than the original — it shares an author with the engine, where the original was deliberately written first — and its own header says so.

**ELA carries no usable signal on this corpus.** An AUC of 0.502 against matched controls is chance: mean score 0.138 on tampered documents versus 0.135 on untampered ones with identical compression history. This is a measured negative result, not an unfinished feature — the control group exists precisely so this could be detected rather than assumed (PROJECT_REPORT.md §7.3). Tier 2 is weighted accordingly.

<!-- METRICS:END -->

## Equity

A system asking "which economically vulnerable applicants look suspicious" can systematically flag people whose circumstances are irregular but not fraudulent — bereavement, relocation, joint families, migrant households, siblings applying in the same cycle.

```bash
npm test -- equity.regression
```

`apps/api/test/equity.regression.test.ts` asserts that every legitimate-but-anomalous fixture produces **zero** high-severity flags. It is run and reported separately so it is independently checkable.

Stated plainly: those fixtures and the rules share an author, so passing proves *"the cases I anticipated are exempted,"* not *"the system is fair."* The trigger list is derived from documented circumstances and frozen before the rules are written, which narrows the gap without closing it.

## Security model

| Concern | How it is handled |
|---|---|
| **Applicant auth** | Passwordless magic link, scoped to their own application. Tokens stored hashed. |
| **Staff auth** | Invite-only, password + optional TOTP (RFC 6238, checked against the RFC's own test vectors). Recovery codes hashed; a spent time-step cannot be replayed. The second factor is verified *after* the password so a wrong password and a wrong code are indistinguishable. |
| **Score isolation** | Applicant-facing payloads are built by explicit construction, never by spreading a row. `test/serializer.test.ts` asserts at runtime that no applicant response contains a score, flag or household. |
| **Session tokens** | `httpOnly` cookie set by a route handler; JavaScript never holds the token, so an XSS bug cannot read it out of storage — it was never put there. |
| **Uploads** | Server-side MIME sniffing from the bytes, size and page caps, parsed in the isolated Python service, never executed. |
| **Audit log** | Append-only at the database grant level. There is no update or delete helper in the module, and the application role holds no such grant. |
| **Retention** | Documents are purged a configured interval after a terminal decision. The row survives carrying `sha256` and `purged_at`, so the audit trail outlives the file. |
| **Tips** | No session read, submitter address salted and hashed before storage, never in the reviewer payload. A tip writes **no flag and no score** — an anonymous accusation that silently reorders a queue is a denunciation box. |

## Repository layout

```
apps/
  api/            Express API + BullMQ worker (one image, two commands)
    src/
      household/  THE ENGINE — normalize, resolve, components, rules, checklist
      pipeline/   five stages, idempotent stage runner, dead-letter handling
      routes/     applications, queue, households, admin, auth, tips, documents
      auth/        passwords, tokens, TOTP, middleware
      evaluation/ in-memory harness shared by every recall suite
      jobs/       document retention
    test/         unit suites + test/integration (needs Postgres)
  web/            Next.js App Router — queue, detail, apply, status, admin, tip, security
  ocr-service/    Python/FastAPI — Tesseract extraction, ELA, metadata forensics
config/           rules.v1…v5.json — versioned weights, never edited in place
db/
  migrations/     forward-only SQL
  seed/           synthetic corpus generator + the three pattern sets
infra/            docker-compose.yml — the whole stack
```

The engine is `apps/api/src/household/`. Everything else is delivery.

## Run the whole thing

```bash
docker compose -f infra/docker-compose.yml up -d --build
```

That is the entire stack — Postgres, Redis, MinIO, the OCR service, the API, the pipeline worker, the Next.js front end, and a mail catcher. Migrations run first, as their own service, and everything that touches the schema waits on them. Then:

```bash
npm install && npm run seed     # synthetic applications + two staff accounts
```

| | |
|---|---|
| Front end | <http://localhost:3000> |
| API | <http://localhost:4000> |
| Inbox (magic links, invitations) | <http://localhost:8025> |
| MinIO console | <http://localhost:9001> |

Sign in at `/login` as `reviewer@scholarshield.local` with `scholarshield-dev`.

Nothing in that compose file is safe to deploy. The secrets are literals, the object store is open on a known password, and it runs the API and worker in development mode. Its known `JWT_SECRET` is explicitly rejected when `NODE_ENV=production`. It exists so the whole system runs on a laptop in one command.

## Develop against it

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis minio minio-init ocr-service mailpit
npm install
npm run migrate
npm run seed
npm run seed:documents     # synthetic certificate corpus, for the OCR metrics
npm run dev                # API
npm run worker             # pipeline worker, separate process
npm run dev:web            # Next.js
```

The worker is a separate process on purpose: OCR is CPU-bound and blocking, and running it inside the API makes request latency a function of how many documents are being read at the time.

## Testing

```bash
npm test                          # unit suite — needs nothing running
npm run test:integration:setup    # once: creates scholarshield_test
npm run test:integration          # pipeline against a real Postgres
npm run metrics                   # regenerates the metrics table, in place
```

| Suite | Covers |
|---|---|
| `rules`, `population`, `certificate` | Every rule, positive and negative. The negative cases matter most: a rule that fires on a population can flag a whole village. |
| `normalize`, `resolve`, `components` | Transliteration, initials, trigram similarity, household detection, edge rejection. |
| `known.recall`, `holdout.recall` | Recall against each pattern set. The holdout suite **prints** recall and asserts almost nothing about it — a test that fails when recall drops makes recall a target, and the fix for a red build would be tuning against the sealed set. It asserts the bookkeeping instead. |
| `equity.regression` | Legitimate-but-anomalous fixtures produce zero high-severity flags. |
| `serializer`, `document-identity`, `totp`, `tips`, `uploads` | The applicant boundary, the certificate-identity check, RFC 6238 vectors, submitter anonymity, MIME sniffing. |
| `integration/` | Idempotency and the end-to-end flow, against a real database. |

Two properties worth knowing:

- **The integration suite fails rather than skips** when it cannot reach a database. A suite that passes because it could not connect is how an unverified claim survives a green build.
- **It runs against its own database** and refuses to start anywhere whose name does not end in `_test`. It truncates between cases, so pointed at your development database it deletes whatever you were working on — which is exactly how that guard came to exist.

## A five-minute walkthrough

For a demo, in this order. Each step shows something the one before it cannot.

1. **`/dashboard`** — the queue, ordered by score. Note what the score does: it decides position and nothing else.
2. **Open the top application.** The checklist shows *every* check, including the ones that passed and the ones that could not run.
3. **The household panel.** The graph shows which applications were resolved together and which field matched on each edge. Reject an edge and the household splits and re-scores — the resolver is contestable, not final.
4. **Decide.** Approve, escalate, reject or trash, each needing a typed reason. There is no path to a terminal status that does not carry a reviewer's id.
5. **`/admin` → audit log.** The decision is already there, append-only, with the reason. Then try `/status` as an applicant: no score, no flag, no household. That boundary is asserted by a test, not by the UI.
6. **`npm run metrics`.** The numbers in this README, regenerated, including the ones that are bad.

## Deploying it for real

The images are production-shaped — multi-stage, non-root, no dev dependencies, healthchecked — and the compose file is not. Before this runs anywhere real:

- **Secrets.** `JWT_SECRET` from a secret store, not a file. The API exits at boot on a placeholder, and on a missing `SMTP_URL`, because a deployment that cannot send a sign-in link cannot sign anyone in.
- **Postgres and object storage** as managed services. The compose Postgres has no backups and the MinIO bucket is created by a shell one-liner.
- **TLS terminating in front of the web and API containers.** Session cookies are `secure` outside development and will not be set over plain HTTP.
- **Proxy boundaries.** Set `TRUST_PROXY_HOPS` to the exact number of proxies in front of the API. This makes rate limits and anonymous-tip abuse hashes use the client address without trusting forged `X-Forwarded-For` headers from direct callers.
- **`NEXT_PUBLIC_API_URL` is baked into the client bundle at build time**, so the web image must be rebuilt per environment. `API_INTERNAL_URL` is the server's separate, private view of the same API.
- **Migrations** run as their own step before the API starts; the compose `migrate` service is the shape to copy.
- Everything under *Limitations* below, and the compliance work in [PROJECT_REPORT.md §14](./PROJECT_REPORT.md) — none of which is code.

## Limitations

This project cannot verify a family's actual income against ground truth — it has no legal access to tax or property records. It flags risk signals; it does not prove fraud. All metrics are scoped to synthetic data. Entity resolution produces both false merges and false splits, which is why a household contradiction is a flag with a visible graph rather than a determination — the reviewer sees the edges and can reject the merge.

Deploying this to a real committee would additionally require DPDP Act compliance review, an institutional data-processing agreement, and an appeals mechanism for flagged applicants. None of that is in scope here.

Four limits are measured rather than anticipated, and they are the ones worth reading first:

- **Detection generalises badly: 30.0%.** That is recall against `patterns.sealed-v2.ts`, authored against fraud mechanisms no rule targets and measured before any rule existed that could catch them. It is the only clean number here. The engine surfaces 3 of 10 applications it should, and 5 of its 6 mechanisms have no rule at all.
- **The original sealed holdout is spent.** It reads 70.6%, up from 38.2% before the population-level rules, but that figure is no longer a generalisation measure: the v3 metrics note named the missing rule families and v4 was written against them. The sealed case data was never opened and no threshold was tuned to a case — the choice of *what to build* was still informed by the set's own results. Full accounting in `db/seed/holdout-status.ts`.
- **Document forensics does not work here.** ELA scores tampered and untampered documents identically (AUC 0.502, where 0.500 is chance). Tier 2 contributes nothing on this corpus. This is a measured negative result, not an unfinished feature — the matched control group exists precisely so it could be detected rather than assumed.
- **OCR is 91.7% accurate per field**, and only 59 of 87 documents are read entirely correctly, so roughly one in three carries at least one misread field. Every extracted value reaches the reviewer with its confidence attached for that reason, and a field read below the confidence floor is skipped rather than failed.

There is also no district income signal at all: Tier 4 was cut. Every shipped signal is *relative* — to a sibling, to the applicant's own certificate, or to the rest of the cycle — so a household that lies consistently, alone, in a district with few other applicants is not something this system can see.

**The next honest number needs a set this project's author did not write.** That is the one piece of evidence neither tuning nor discipline can manufacture.

Full limitations: [PROJECT_REPORT.md §14](./PROJECT_REPORT.md).

## Stack

| Layer | Technology |
|---|---|
| Web | Next.js (TypeScript, App Router) |
| API + worker | Express (TypeScript), BullMQ |
| OCR + forensics | Python, FastAPI, Tesseract, Pillow/NumPy |
| Database | PostgreSQL + `pg_trgm` |
| Object storage | MinIO (local) / S3 or R2 (deployed) |
| Queue | Redis + BullMQ |
| Mail | Mailpit (local) / any SMTP (deployed) |
| Local dev | Docker Compose |

## Documentation

- [PROJECT_REPORT.md](./PROJECT_REPORT.md) — problem analysis, design rationale, milestones, limitations
- [db/seed/holdout-status.ts](./db/seed/holdout-status.ts) — which sealed cases are now targeted, and why the first holdout is spent
- [scholarshield-fixes-log.md](./scholarshield-fixes-log.md) — revision history of the design

## License

MIT
