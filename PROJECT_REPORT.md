# ScholarShield
### Scholarship Fraud Risk-Triage Platform — Project Report (v3)

---

## 1. Problem

Indian college scholarship programs reserved for economically weaker students are routinely claimed by students whose families are not economically weak. The mechanism is an income certificate declaring a household income far below reality — declarations as low as ~₹72,000/year from families earning well above ₹10 LPA.

This is documented, not hypothetical:

- Tripura's government issued show-cause notices and pursued FIRs against 34 students for submitting fake documents to claim post-matric scholarships ([Deccan Herald](https://www.deccanherald.com/amp/story/india%2Ftripura%2Ftripura-govt-issues-show-cause-notices-34-st-students-who-submitted-fake-docs-to-get-scholarship-3475877), [Careers360](https://news.careers360.com/tripura-government-issues-show-cause-notices-34-st-students-who-submitted-fake-documents-get-post-matric-scholarship/amp)).
- Case law on false income certificates submitted for scholarship purposes exists across Indian courts ([CaseMine](https://www.casemine.com/search/in/false+income+certificate+for+scholarship)).
- Submitting a fake certificate is a criminal offence — forgery plus defrauding a public authority ([Sudhir Rao](https://sudhirrao.com/legal-consequences-of-faking-income-for-a-scholarship-in-india/), [LawRato](https://lawrato.com/civil-legal-advice/punishment-for-producing-fake-income-certificate-to-get-rebate-in-fee-245367)).
- Verification today is almost entirely **reactive**. The [National Scholarship Portal](https://scholarships.gov.in/) relies on manual review by Tehsildars and State/District Nodal Officers at intake; fraud surfaces later through police investigation, if at all.

**The specific gap this project targets:** several states already run a public certificate-authenticity lookup — Tamil Nadu's e-District [`VerifyCerti`](https://tnedistrict.tn.gov.in/tneda/VerifyCerti.xhtml), [Digital Gujarat](https://portal.digitalgujaratscholarships.com/certificate-verification-gujarat/) — which answers *"was this certificate issued?"* But the dominant fraud pattern is a certificate that **was** genuinely issued and still misrepresents the family's position. Nothing available to a college cross-references applications **against each other**, which is where that pattern becomes visible: a sibling's separately filed application declaring a different household income, three "unrelated" low-income applicants at one address, the same guardian appearing with two incomes.

That cross-referencing capability is the core of this project. Everything else is supporting evidence.

## 2. What already exists, and why it isn't enough

| Existing mechanism | What it does | Limitation |
|---|---|---|
| State e-District lookups (TN `VerifyCerti`, Digital Gujarat) | Confirms a certificate ID was genuinely issued | Standalone; nobody wires it into review; blind to a genuinely-issued certificate with a misleading income |
| NSP manual review (Tehsildar / Nodal Officer) | Human document check at intake | No cross-application analysis, no anomaly detection, one reviewer's judgment per file |
| Post-hoc FIR / legal action | Punishes fraud afterward | Doesn't prevent wrongful award; slow, rare, resource-intensive |
| Commercial KYC APIs (SurePass-style) | Sells certificate-authenticity checks to businesses | Not built for or accessible to college committees; no workflow layer |

The opportunity is the **triage layer** — the thing sitting between document upload and human decision, built only on signals a college can legally and practically obtain.

## 3. What ScholarShield is

A decision-support platform for college scholarship committees. It ingests submitted applications and income certificates, reconciles each application against every other application in the cycle, and produces an **explainable risk score** that determines *review order*. It does not approve, reject, or accuse.

One sentence for an interview: *"It's an entity-resolution and contradiction-detection engine over scholarship applications, with document forensics as a secondary signal and a human decision required at every exit."*

## 4. Design principles

These are enforced by the schema and the code paths, not by policy language.

1. **No automated verdicts.** Score changes queue position and nothing else. There is no code path by which the system rejects an application. `applications.status` reaches a terminal state only via a row in `reviews` carrying a `reviewer_id` and a non-empty typed reason.
2. **Manual verification is the primary path.** The system generates a pre-filled link to the state's public verification portal for every certificate. It never scrapes a government portal (§5 Tier 3, §14) and never fabricates or infers a verification result.
3. **Synthetic data only.** Every applicant, family, address, and certificate image in this project is generated. No real student's document is ingested at any point.
4. **Every decision is auditable.** Approve / escalate / reject each require a typed reason and write an immutable `audit_log` row. The audit log is append-only at the database level — the application role holds no `UPDATE` or `DELETE` grant on that table.
5. **Every flag is explainable.** No black-box model in v1. Each flag carries a human-readable reason string, the rule ID that produced it, the rule-config version, and the exact field values that triggered it.

## 5. Risk signals, in order of weight

The ordering here is deliberate and is the main structural change from earlier drafts. Tier 1 is the product. Tiers 2–5 are corroboration.

### Tier 1 — Household reconciliation graph (the core engine)

The one signal that needs no external data, no ML, and no legal ambiguity, and that directly targets the fraud pattern in §1.

1. **Normalize** every application's identity fields — applicant name, guardian names, address, phone, certificate issuing office — into comparable tokens (transliteration-tolerant, honorific-stripped, address abbreviations expanded).
2. **Entity-resolve** across applications using Postgres `pg_trgm` trigram similarity plus exact-match keys, producing weighted edges between applications that plausibly share a household.
3. **Component detection** — connected components over that graph are candidate households.
4. **Contradiction rules** run within each component and across components:

| Rule | Fires when | Weight |
|---|---|---|
| `SIBLING_INCOME_CONTRADICTION` | Two applications in one household declare household incomes differing beyond a configured tolerance | High |
| `GUARDIAN_INCOME_CONTRADICTION` | The same resolved guardian appears with materially different incomes across applications | High |
| `ADDRESS_CLUSTER_UNRELATED` | N+ applications share a normalized address across *different* components, all below the income threshold | Medium |
| `ISSUING_OFFICE_MISMATCH` | Certificates for one household come from different issuing offices | Low |
| `DEADLINE_PROXIMITY` | Certificate issue date sits in a narrow window before the deadline **and** another Tier-1 rule already fired | Low (never fires alone) |

`DEADLINE_PROXIMITY` is deliberately non-independent: siblings filing in the same admission cycle get certificates at the same time, and that is normal. It only contributes when something else already did.

**Why this is the strong part:** it is real engineering (normalization, fuzzy entity resolution, graph components, contradiction logic over the result), fully explainable, degrades gracefully, and it is the only signal that catches a *genuine* certificate carrying a false income.

### Tier 2 — Document forensics

Error Level Analysis plus file-metadata consistency on the uploaded certificate, producing a tamper-likelihood score.

ELA has a real false-positive rate on ordinary JPEG recompression, independent of tampering. Rather than disclaim that and move on, this project **measures it** against an untampered control group and publishes the number (§7). Forensics contributes a bounded fraction of total score and cannot alone push an application into the high-severity band.

Metadata checks: producer/creator software inconsistent with the issuing authority's known output, EXIF/XMP timestamps inconsistent with the stated issue date, and evidence of resave chains.

### Tier 3 — Certificate authenticity

For every certificate, the system generates a **pre-filled manual-verification link** to the relevant state portal. That is the shipped path, and it always works.

Behind a `CertificateVerificationAdapter` interface sit two implementations: `ManualLinkAdapter` (default) and `MockStateAdapter` (seeded fixtures, for tests and demo). **No scraping adapter is built.** The interface exists so a state that publishes an official API can be added without touching anything else — the architecture story is preserved and the ToS exposure is zero. This was previously budgeted as a week of work against a portal likely to CAPTCHA-block it; that week now goes to Tier 1.

### Tier 4 — Locality income band (soft signal, low weight)

Declared income compared against district-level reference income from [data.gov.in's "District wise Per Capita Income"](https://www.data.gov.in/catalog/district-wise-capita-income-current-prices) datasets, published under NDSAP.

The earlier draft compared a **household** income certificate against a **per-capita** district figure — different units, which makes the comparison meaningless. Corrected: the engine divides declared household income by declared family size and compares per-capita to per-capita, firing only when the result exceeds the district figure by a wide multiple. District averages mask enormous intra-district variation, the dataset lags by years, and family size is self-declared — so this signal is capped at a low weight and is the first cut candidate if it proves noisy on the seed set.

### Tier 5 — Anonymous tip intake

A lightweight form routing into the same queue as a distinct, clearly-labeled flag type. A tip **cannot move an application into the high-severity band on its own** — it attaches a visible flag for the reviewer and nothing more. Abuse controls in §11.

### Scoring

A **versioned weighted rule engine** — `config/rules.v1.json`, checked into the repo, loaded at boot, with the version stamped onto every `risk_flags` row so a historical score is always reproducible against the config that produced it. No trained model in v1. Future work: an isolation forest could sit alongside the rules as a secondary signal, never a replacement.

## 6. Equity and false positives

A system whose subject is "which economically vulnerable applicants look suspicious" can systematically flag people whose circumstances are irregular but not fraudulent. This is a first-class design constraint.

**Legitimate triggers designed around** — each drawn from documented real-world circumstances, not invented for convenience:

- Recent death or job loss of an earner: sudden income drop with no paper trail yet.
- Family relocation: address mismatch across records.
- Siblings applying in the same admission cycle: certificates issued days apart is normal.
- Remarriage or custody change affecting registered address.
- Joint/extended family at one address: multiple genuinely low-income families, one building.
- Migrant labour households: address of record differs from address of residence.

**Mitigations:**

- Every flag carries a reason string and its contributing weights, so a flagged-but-legitimate case is fast to *clear* rather than defaulting to suspicion.
- No flag type auto-escalates beyond "review sooner." A high score changes queue order, never applicant-facing outcome, and never bypasses the typed-reason audit requirement.
- `ADDRESS_CLUSTER_UNRELATED` and `DEADLINE_PROXIMITY` — the two rules most likely to hit joint families and sibling cycles — are weighted Medium and Low respectively, and the latter cannot fire alone.
- The seed dataset deliberately includes legitimate-but-anomalous cases alongside genuine and fraudulent ones.

**Tested, with the circularity acknowledged.** `apps/api/test/equity.regression.test.ts` asserts that every legitimate-but-anomalous fixture produces no high-severity flag, run and reported separately (`npm test -- equity.regression`) so it is independently checkable.

That suite has a known weakness worth stating plainly: the fixtures and the rules are authored by the same person, so passing proves *"the cases I anticipated are exempted,"* not *"the system is fair."* Two things reduce that gap — the trigger list above is derived from documented circumstances rather than imagination, and the list is **frozen before the rules are written** (§7). Neither is a substitute for evaluation against real applicants, which this project cannot perform.

## 7. Breaking the validation circularity

Earlier drafts admitted the rule engine was validated only against synthetic data generated to match its own detection patterns, and left it there. An admission is not a fix. This section is the fix, and it is the part of the project most worth defending in an interview.

Three mechanisms, each producing a number rather than an assurance.

### 7.1 Held-out fraud patterns (sealed before the rules exist)

The seed generator carries two pattern files:

- `seed/patterns.known.ts` — the fraud patterns the rules are written against.
- `seed/patterns.holdout.ts` — **authored and committed before any rule code is written, then not opened again until Week 5.**

Recall is measured separately on each. Recall on `known` measures internal consistency. Recall on `holdout` is the honest number: how much fraud the engine catches that it was not built to catch. Git history proves the ordering — the holdout commit predates the rule-engine commit, which is checkable by anyone reviewing the repo.

### 7.2 Document realism pipeline

OCR that reads cleanly-rendered images produced by the same script proves nothing. Every generated certificate passes through a degradation pipeline before it ever reaches the OCR service:

- rotation ±3°, mild perspective warp (phone-photo geometry)
- uneven illumination gradient, Gaussian noise
- JPEG recompression at quality 65–85
- optional grayscale/scan-line simulation on a subset

OCR field-level accuracy is measured against this degraded corpus and reported as a metric, not assumed.

### 7.3 Tamper generation decoupled from tamper detection

Tampered documents are produced through a **different image path than the detector assumes** — composited and resaved via an independent pipeline, rather than the single-library edit ELA is trivially good at spotting.

Critically, the corpus includes a **control group: untampered documents that have been recompressed exactly as often as the tampered ones.** ELA's false-positive rate is measured on that control group and published. This converts "ELA has a known false-positive rate" from a disclaimer into a measured property of this system.

## 8. Metrics this project publishes

Stated up front so they can't be quietly dropped if they come out unflattering. All are scoped to the synthetic corpus — that scope is stated everywhere the numbers appear.

| Metric | Definition | Why it matters |
|---|---|---|
| **Precision@k** | Share of the top-*k* risk queue that is genuinely fraudulent in the seed data | The actual product metric — a triage tool's job is ranking, not classification |
| **Queue lift** | Fraud density in the top decile vs. the base rate | Answers "does using this beat reviewing in arrival order?" — the only question a committee cares about |
| **Holdout recall** | Recall against `patterns.holdout.ts` (§7.1) | The non-circular accuracy number |
| **Known recall** | Recall against `patterns.known.ts` | Internal consistency baseline; the gap between this and holdout recall is the honest measure of overfitting |
| **ELA false-positive rate** | Share of untampered-but-recompressed controls flagged (§7.3) | Turns a known caveat into a bounded, measured one |
| **OCR field accuracy** | Per-field accuracy on the degraded corpus (§7.2) | Proves the CV layer works on something it wasn't handed clean |
| **Equity pass rate** | High-severity flags on legitimate-anomalous fixtures — target: zero | The fairness floor |

Every one of these is computed by a script (`npm run metrics`) that writes a report into the README, so the numbers in the documentation are generated, never hand-typed.

## 9. Tech stack

| Layer | Technology | Why |
|---|---|---|
| Frontend | **Next.js** (TypeScript, App Router) | Dashboard-heavy UI, server components for the risk queue; matches existing strength (Vaxi-Track, CodeMap, InboxIQ) |
| Backend API | **Express** (TypeScript) | REST API, auth, BullMQ producer, scoring orchestration; reuses existing Express experience |
| OCR + forensics | **Python (FastAPI)** + Tesseract/EasyOCR + Pillow/NumPy | Python's CV/OCR ecosystem is materially better here; the one deliberate new skill, isolated to the layer that needs it |
| Database | **PostgreSQL** + `pg_trgm` | Relational integrity for the audit trail; trigram similarity is what makes Tier 1 entity resolution practical without a separate search service |
| Object storage | **MinIO** locally (S3-compatible), S3/R2 in deploy | Documents never live in Postgres or on the app filesystem |
| Job queue | **Redis + BullMQ** | Async OCR → forensics → verification → scoring pipeline; the pattern already proven in InboxIQ's Gmail sync |
| Deployment | **Vercel** (web) + **Railway/Render** (API, worker, Postgres, Redis), or single-VPS Docker Compose | Low-friction, matches existing deployment patterns |
| Local dev | **Docker Compose** | One command brings up Postgres + Redis + MinIO + all three services |

**Why not pure Node:** Python/FastAPI is the *only* new ecosystem, chosen because OCR/CV genuinely benefits and nothing else does. An earlier draft also swapped the backend to Java/Spring Boot, making this a three-ecosystem build; that was reverted to keep schedule risk confined to the one layer that actually requires a new skill.

## 10. Architecture

```
scholarshield/
  apps/
    web/                 Next.js — applicant upload (synthetic demo) + admin review dashboard
    api/                 Express — REST, auth, BullMQ producer, scoring orchestration
      src/household/     Tier 1 engine: normalize, resolve, component-detect, contradict
      test/equity.regression.test.ts    named equity suite (§6)
      test/holdout.recall.test.ts       non-circular accuracy suite (§7.1)
    ocr-service/         Python FastAPI — OCR extraction + ELA/metadata forensics
  packages/
    shared/              Shared TS types (Application, Document, RiskFlag, Household, …)
  config/
    rules.v1.json        Versioned rule weights, loaded at boot, stamped onto every flag
  infra/
    docker-compose.yml   Postgres + Redis + MinIO + three services
  db/
    migrations/          SQL migrations
    seed/
      patterns.known.ts     fraud patterns the rules target
      patterns.holdout.ts   sealed until Week 5 (§7.1)
      degrade.ts            document realism pipeline (§7.2)
      tamper.ts             independent tamper path + recompression controls (§7.3)
  scripts/
    metrics.ts           computes and writes §8 metrics into the README
```

**Processing pipeline** (BullMQ, triggered on upload):

1. **OCR extraction** (Python) → name, declared income, certificate ID, issuing authority, issue date, family size
2. **Image forensics** (Python) → ELA heatmap + metadata consistency → tamper-likelihood score
3. **Certificate verification** (Express) → manual-verification link generated; adapter result recorded as `manual_check_required` unless an adapter supplies one
4. **Household reconciliation** (Express/Postgres) → normalize, entity-resolve, component-detect, run contradiction rules
5. **Risk scoring** → weighted rule engine → `risk_flags` rows, each with reason string + rule ID + config version
6. Result surfaces in the **admin risk queue**, sorted by score, drillable into "why"

**Pipeline semantics** — worth being explicit about, since it's a genuine interview point:

- Every stage handler is **idempotent**, keyed on `(document_id, stage)`. BullMQ is at-least-once; a redelivered job must not double-write flags.
- Stage results are **persisted as they complete**, so a retry resumes from the failed stage rather than restarting the chain.
- Retries use exponential backoff with a capped attempt count; exhausted jobs land in a **dead-letter queue** surfaced in the admin UI rather than failing silently.
- Stage 4 (household reconciliation) re-runs for *every application in the affected component* when a new application joins it — a contradiction is a property of the household, not of one upload.

**Admin dashboard:** risk queue (sortable/filterable by score and flag type) · application detail (extracted fields, forensics heatmap overlay, verification status, **household graph visualization** showing the resolved component and which edges triggered which rule) · reviewer actions (approve/escalate/reject, each requiring a typed reason) · anonymous tip form.

**Auth and personas:**

- **Applicants** — passwordless magic-link, scoped strictly to their own application. No applicant can see a score, a flag, or another application.
- **Reviewers / Admins** — invite-only accounts, password + optional TOTP, role-based (`reviewer` can decide; `admin` can invite users and edit rule config). Rule-config edits are themselves audit-logged.
- Risk scores and flags are **never exposed on any applicant-facing endpoint** — enforced at the serializer, not just the UI.

**Core tables:** `users` · `applicants` · `applications` · `documents` · `households` · `household_edges` · `verification_results` · `risk_flags` · `reviews` · `audit_log` · `tips`

**Data retention:** documents are purged from object storage a configured interval after an application reaches a terminal decision; the `audit_log` retains the decision, reason, reviewer, and a document hash — never the document itself. Retention is a scheduled job, not a manual promise. Documents are served only via short-TTL signed URLs; the bucket is never public.

## 11. Security and abuse threat model

| Vector | Mitigation |
|---|---|
| Malicious upload (polyglot file, zip bomb, embedded script) | Server-side MIME sniffing, size caps, page-count caps, render/parse in the isolated Python service, never execute |
| Applicant enumerating other applications | Authorization checked per row, not per route; applicant tokens scoped to a single application ID |
| Score/flag leakage to applicants | Separate serializers for applicant and reviewer responses; a test asserts no applicant-facing payload contains a scoring field |
| Tip-form abuse / harassment | Per-IP and global rate limits, hashed IP retention only, tips capped in scoring weight (§5 Tier 5), reviewers can mark a tip abusive to suppress it |
| Reviewer acting outside process | Append-only audit log with no application-role delete grant; every terminal decision requires reviewer ID + typed reason |
| Rule tampering to change historical scores | Rule config versioned and stamped per flag; edits audit-logged; historical scores always reproducible |

## 12. Milestones — 6 weeks core + 1 buffer

The earlier estimate of 4–6 weeks came from removing Java's learning curve, but the feature count never shrank. Cutting the scraping adapter (§5 Tier 3) buys back real time; the buffer week is restored because a solo three-service build needs one regardless of ecosystem count.

1. **Week 1 — Scaffold + seal the holdout.** Repo init, Docker Compose (Postgres + Redis + MinIO), schema and migrations, Express skeleton with role-based auth, Next.js skeleton with upload form and dashboard shell. **`patterns.holdout.ts` is authored and committed this week, before any rule code exists (§7.1).**
2. **Week 2 — Tier 1 engine.** Normalization, `pg_trgm` entity resolution, component detection, contradiction rules, unit tests. The core ships first, not last.
3. **Week 3 — Data generation.** Seed generator with genuine / fraudulent / contradictory / legitimate-anomalous cases, the degradation pipeline (§7.2), and the independent tamper path plus recompression controls (§7.3).
4. **Week 4 — OCR + forensics.** Python FastAPI service, Tesseract/EasyOCR extraction, ELA and metadata checks, wired through BullMQ with idempotent handlers and a DLQ.
5. **Week 5 — Scoring, verification, metrics.** Versioned rule engine; manual-link generation and the adapter interface; import and normalize the data.gov.in district table; **open the holdout set and compute every §8 metric.**
6. **Week 6 — Review workflow.** Risk queue, application detail with household graph visualization, reviewer decisions and audit trail, anonymous tip form with abuse controls.
7. **Week 7 — Buffer, polish, deploy.** Tests, README with generated metrics and an explicit Limitations & Ethics section, deployment, seeded demo dataset, scripted demo walkthrough.

**Cut order if behind schedule** (protects the core path — Tier 1 → scoring → review UI): Tier 4 locality signal first, then Tier 5 tip form, then the household graph *visualization* (the engine stays; only the picture goes).

## 13. Verification plan

- Unit tests for normalization and entity resolution against fixed name/address pairs, including transliteration variants.
- Unit tests for each contradiction rule: specific synthetic inputs → specific expected flags and weights.
- **`holdout.recall.test.ts`** (§7.1) — recall against the sealed pattern set, reported separately from known-pattern recall.
- **`equity.regression.test.ts`** (§6) — legitimate-anomalous fixtures produce zero high-severity flags, run and reported separately.
- Serializer test asserting no applicant-facing response contains a score or flag field.
- Idempotency test: replaying a completed pipeline job produces no duplicate `risk_flags` rows.
- Integration test: upload → pipeline completes → correct flags created → application appears at the expected queue position.
- `npm run metrics` produces the §8 table; CI fails if the equity suite regresses.
- Manual QA through the full flow: upload → review → decision → audit log.
- `docker-compose up` brings up the entire stack on a laptop — this must just work for live demos.

## 14. Known limitations

- **Cannot verify actual income against ground truth.** No legal access to IT or property records. The system flags risk signals; it does not prove fraud, and no output should ever be described as proof.
- **All metrics are scoped to synthetic data.** §7 makes the numbers meaningfully less circular — a sealed holdout set, degraded documents, an independent tamper path — but there is no real fraud-labeled dataset to validate against, and this project cannot produce one. Every number in §8 is reported as "against the synthetic corpus," never generalized.
- **The equity suite shares an author with the rules** (§6). Frozen fixtures and documented triggers narrow that gap; they don't close it.
- **Entity resolution will produce both false merges and false splits.** Common names in Indian datasets are genuinely ambiguous, and no tuning removes that. This is why a household contradiction is a *flag with a visible graph*, not a determination — the reviewer sees the edges and can reject the merge.
- **No scraping of government portals.** Certificate authenticity is reviewer-driven by design; the adapter interface exists for a future official API, not as a stalled TODO.
- **ELA remains a prioritization signal, not evidence** — now with a measured false-positive rate (§7.3) rather than an unquantified caveat.
- **The district income table is a periodically re-imported static dataset**, lagging by years, with averages masking intra-district variation. Even normalized per-capita, it stays a low-weight soft signal.
- **Deployment to a real committee would require more than this repo:** DPDP Act compliance review, an institutional data-processing agreement, and an appeals mechanism for flagged applicants. None of that is in scope, and the README says so.

## 15. Why this is a strong project

- **Not an AI-wrapper CRUD app.** Entity resolution over fuzzy human-entered data, graph contradiction detection, async multi-stage pipelines with real idempotency semantics, and a polyglot service boundary.
- **The hard part is the differentiated part.** The core engine is the thing nothing else does (§1), not a wrapper over a library someone else wrote.
- **Grounded in research, not a prompt.** Real government portals, real fraud cases, a real public dataset, and an honest account of what each one can and cannot support.
- **Measured, not asserted.** §7 and §8 are the difference between "we know this is a risk" and "here is the number, here is how we got it, here is the git history proving the holdout was sealed first." Very few portfolio projects can show that.
- **Responsible system design as engineering, not marketing.** Explainability, human-in-the-loop, append-only audit, applicant-facing score isolation, retention policy, and a threat model — all enforced in schema and tests.
- **One new ecosystem, honest timeline.** Python/FastAPI for CV only; 6 weeks plus a real buffer and a stated cut order.
- **Extends existing strengths** — CodeMap's analysis-engine mindset, InboxIQ's async pipeline pattern, the security-scanner hackathon work and Google Cybersecurity cert — into one coherent flagship.

## 16. First implementation step

Scaffold the repo: folder structure per §10, Docker Compose for Postgres + Redis + MinIO, migrations for the core schema including `households` and `household_edges`, an Express skeleton with health check and auth stub, a Next.js skeleton with placeholder upload form and dashboard shell, and a README carrying the problem statement, the ethics stance, and pointers to both named test suites.

**In the same week, before any rule code:** author and commit `seed/patterns.holdout.ts`. The value of §7.1 depends entirely on that commit landing first, and it cannot be recreated later.
