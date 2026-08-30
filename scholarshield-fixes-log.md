# ScholarShield — Fixes Log

Applied to the project report (`prancy-purring-kurzweil.md`) on 2026-08-16. Each entry: what was wrong, what changed, where.

> **Round 2 note:** entry #6 below (Express → Spring Boot/Java) was reverted in Round 2, fix #1. The Java swap is kept in this log for history, but the report no longer reflects it — see Round 2 below for the current state.

## 1. Equity / false-positive blind spot
**Problem:** A risk-scoring system for "who looks suspicious" would disproportionately flag applicants whose life circumstances are genuinely irregular but not fraudulent (bereavement, relocation, same-cycle sibling filings) — the report had no answer to "what could go wrong" from an equity angle.
**Fix:** Added new §3.3 "Equity & False-Positive Considerations" — names the specific legitimate triggers, states the mitigations already in the design (reason strings + weights shown to reviewer, queue-order-only impact, never auto-escalation), and states honestly that no real-world false-positive rate has been validated.
**Also touched:** §3.2 signal 3 (cross-application consistency) and §7 (verification plan now requires tests asserting legitimate-but-anomalous inputs do NOT produce high-severity flags, not just that fraud is caught).

## 2. Circular validation of the rule engine
**Problem:** The only test data is synthetic data generated to match the rules' own detection patterns — this proves internal consistency, not real-world accuracy, and the report didn't say so.
**Fix:** Added explicit limitation to §9: any precision/recall claim must be scoped to "against the synthetic test set," never generalized. Also flagged ELA's known false-positive rate on ordinary JPEG recompression, separate from actual tampering.

## 3. Legal/ToS risk on the `VerifyCerti` scraping adapter
**Problem:** §3.1 guardrail #2 read as if CAPTCHA/anti-automation risk was an incidental discovery ("if that portal requires a CAPTCHA (likely...)"), not something evaluated up front.
**Fix:** Reworded §3.1 guardrail #2 to state the ToS/legal ambiguity of automated querying against a government portal was considered before design, with the manual-fallback link as the deliberate mitigation — not a fallback bolted on after the fact.

## 4. Scope vs. 4–6 week timeline
**Problem:** Three services, five risk signals, a full dashboard, and a rule engine in 4–6 weeks solo was already tight before Java was added — adding a second new ecosystem (Java/Spring Boot, alongside Python/CV) made the original estimate unrealistic.
**Fix:** §6 extended to 6–8 weeks, with Weeks 2–4 explicitly named as the risk zone, a dedicated buffer week (Week 6) added, and named cut candidates if behind schedule (locality income-band signal, anonymous tip form) that protect the core demo path (OCR → forensics → verification → scoring → review UI).

## 5. Locality income-band data source unverified
**Problem:** §3.2 signal 4 cited "publicly published district-level income bands" without confirming such a source exists at usable granularity — risk of shipping on placeholder/fabricated numbers.
**Fix:** Marked this signal explicitly as "not yet confirmed viable for v1" in §3.2 — must locate a real public data source before building it, otherwise it's deferred to post-v1. Also listed as a first cut candidate in §6 if the source isn't found in time.

## 6. Backend swapped from Express (Node) to Spring Boot (Java)
**Problem:** User requested the backend be rebuilt in Java instead of TypeScript/Express.
**Fix — full stack cascade, not just a label swap:**
- **API/orchestration:** Express → **Spring Boot**, with **Spring Security** for role-based auth (§4, §5, §6, §10)
- **Job queue:** BullMQ (Node, Redis-backed) → **RabbitMQ + Spring AMQP** — the idiomatic Java async-messaging pattern. Redis is dropped entirely rather than kept alongside RabbitMQ, since it was only there to back the queue (§4)
- **Rate limiting** for the `VerifyCerti` adapter: moved from an implicit Redis-based approach to **Bucket4j** (in-process Java), removing the need for Redis just for this (§4)
- **DB migrations:** generic SQL migrations → **Flyway**, the Spring-ecosystem standard (§4, §5, §10)
- **Cross-service types:** the original shared TypeScript `packages/shared` package doesn't work once the backend is Java — replaced with an **OpenAPI/JSON Schema contract** (`contracts/openapi.yaml`) that generates TS types for Next.js and Java DTOs for Spring Boot (§4, §5)
- **Resume framing (§8) rewritten:** originally the stack was framed as "matches existing Node/Express strength." Now it's honestly framed as **two new ecosystems added in one project** (Java/Spring Boot + Python/CV), with the InboxIQ async-pipeline pattern reimplemented in Java/RabbitMQ as its own interview point (the pattern transfers across stacks, not just the code) — this reframing is also *why* fix #4 (timeline) was necessary.

## Net effect (Round 1)
The report now states its own risks (equity, validation, legal, scope, data-source, ecosystem-learning-curve) instead of leaving them for an interviewer to find, and the architecture is internally consistent for a Java backend (no leftover Redis/BullMQ/shared-TS-package references). Nothing in this log was silently dropped — every original signal and milestone still exists, just re-scoped or explicitly flagged as conditional.

---

## Round 2 — 2026-08-16

### 1. Cut ecosystem count from three new stacks to one
**Problem:** The Java swap (Round 1, #6) made this a three-ecosystem build (TS/Next.js, Java/Spring Boot, Python/CV) — more schedule risk than the project needed, since Java wasn't buying anything the user's existing Express experience didn't already cover.
**Fix:** Reverted the backend to the original **Express (TypeScript)**. Removed Spring Boot, Spring Security, Spring AMQP, Bucket4j, Flyway, and the OpenAPI/DTO-generation contract entirely. Restored **Redis + BullMQ** for the job queue and the shared TypeScript `packages/shared` types package (§4, §5). Python/FastAPI remains the *only* new ecosystem, since OCR/CV genuinely needs it and nothing else does (§4, §8).
**Also touched:** §6 timeline shrunk back to **4–6 weeks**; the "risk zone" / buffer-week language from Round 1 (added specifically because of the Java addition) was removed since the reason for it no longer applies.

### 2. Resolved Signal #4 (locality income-band anomaly) instead of leaving it conditional
**Problem:** Round 1 marked this signal "not yet confirmed viable for v1" — an unresolved TODO, which reads as less finished than a firm decision either way.
**Fix:** Searched for a real public data source. Confirmed one exists: **data.gov.in's "District wise Per Capita Income at Current/Constant Prices"** datasets, published under India's National Data Sharing and Accessibility Policy (NDSAP) — downloadable, district-level, real government data. Signal #4 is restored to v1 as a committed signal (§3.2), cited by name, with a limitation noted that it's a periodically re-imported static table (no public API found), and that district-level averages mask intra-district variation (§9) — this is why it stays a soft signal, not a determination.

### 3. De-risked the VerifyCerti adapter for live demos
**Problem:** The report treated automated lookup as the primary path and the manual-verification link as a fallback — backwards for a system whose whole premise is "don't depend on an automatable government portal," and risky for a live interview demo if CAPTCHA blocks automation on the spot.
**Fix:** Inverted the framing throughout (§3.1 guardrail #2, §3.2 signal 2, §5 pipeline step 3): the pre-filled manual-verification link is now the guaranteed, always-available primary path; automated lookup is an opportunistic enhancement attempted on top of it. Added to §6 Week 6 and §7: record a screen capture of the automated path succeeding at least once, so the live demo never depends on the portal cooperating in real time.

### 4. Tightened the equity section from "acknowledged" to "tested"
**Problem:** §3.3 stated the equity mitigations weren't validated, but didn't point to a concrete, nameable test artifact — "folded into general rule-engine tests" is easy to lose track of and hard to point to in an interview.
**Fix:** Named the suite explicitly — `apps/api/test/equity.regression.test.ts` (§3.3, §5, §7) — asserting every legitimate-but-anomalous synthetic case produces no high-severity flag, run and reported separately from general rule-engine tests, and called out by name in the README (§10) so it's independently checkable, e.g. `npm test -- equity.regression`.

### 5. Synced architecture, tech stack, and milestones to the reverted stack
**Problem:** §4's tech-stack table and §5's folder structure still described Spring Boot after fix #1; §6 and §10 still referenced a Spring Boot skeleton and Spring Security stub.
**Fix:** §4 tech-stack table restored to Express/BullMQ/Redis/shared-TS-package; §5 folder structure restored to `apps/api` as Express, with the new `equity.regression.test.ts` file called out in the tree; §6 Week 1 and §10 restored to "Express skeleton with role-based auth" / "auth stub," with the equity suite and manual-verification-link-first design folded into the relevant weeks.

## Net effect (Round 2)
The project is back to a two-ecosystem build (TypeScript + Python) with a credible 4–6 week estimate, signal #4 is a firm yes backed by a real cited dataset instead of a maybe, the certificate-verification adapter is demo-safe by design rather than by luck, and the equity claim in §3.3 now points to a specific, nameable, independently-runnable test suite instead of a general assurance.

---

## Round 3 — 2026-08-23

Report rewritten as `PROJECT_REPORT.md` (v3). `prancy-purring-kurzweil.md` retired — its content is fully superseded and preserved in git history at commit `a625d97`.

### 1. Promoted cross-application consistency to the core product
**Problem:** §1 identified the gap as "nothing cross-references applications against each other," then buried cross-application consistency as signal #3 of 5 while OCR/ELA — the fragile, undifferentiated parts — got the whole Python service and two weeks. The thesis and the build order disagreed.
**Fix:** Signals restructured into explicit tiers. Tier 1 is now a **household reconciliation graph**: field normalization, `pg_trgm` fuzzy entity resolution, connected-component household detection, and five named contradiction rules with stated weights. Everything else is Tier 2-5 corroboration. Build order follows: Tier 1 ships Week 2, not Week 4.

### 2. Replaced the circularity admission with actual mechanisms
**Problem:** Rounds 1-2 admitted the rule engine was validated only against synthetic data matching its own patterns, and stopped there. An admission is not a fix, and the equity suite added in Round 2 had the identical flaw it was meant to solve.
**Fix:** New §7 with three mechanisms, each producing a number: (a) **sealed holdout patterns** — `patterns.holdout.ts` authored and committed in Week 1 before any rule code exists, with git history as proof, giving a non-circular recall figure; (b) **document realism pipeline** — rotation, perspective warp, illumination gradient, noise, JPEG recompression applied before OCR ever sees a document; (c) **tamper generation decoupled from detection**, plus an untampered-but-recompressed control group that yields a measured ELA false-positive rate.
**Also:** §6 now states plainly that the equity suite shares an author with the rules, and what does and doesn't narrow that gap.

### 3. Added a published metrics contract
**Problem:** No stated success criteria — nothing that could come out unflattering and be seen to have done so.
**Fix:** New §8 naming seven metrics up front: precision@k, queue lift, holdout recall vs. known recall (the gap between them being the overfitting measure), ELA false-positive rate, OCR field accuracy on degraded documents, and equity pass rate. Computed by `npm run metrics`, written into the README by script so documented numbers are generated rather than hand-typed.

### 4. Cut the VerifyCerti scraper, kept the adapter
**Problem:** Round 2 correctly demoted automated scraping to optional but still budgeted Week 3 for building it — a week against a portal flagged as both ToS-ambiguous and probably CAPTCHA-blocked. The mitigation ("record a screen capture of it succeeding once") was fragile and a strange artifact to produce.
**Fix:** No scraping adapter is built at all. `CertificateVerificationAdapter` ships with `ManualLinkAdapter` (default) and `MockStateAdapter` (fixtures). The pluggable-per-state architecture story survives intact, legal exposure drops to zero, and the reclaimed week goes to Tier 1.

### 5. Fixed the unit mismatch in the locality signal
**Problem:** Signal #4 compared a **household** income certificate against a **per-capita** district figure. Different units — the comparison was meaningless, and a ₹72k household in a district averaging ₹1.5L per-capita is unremarkable for a genuinely poor family.
**Fix:** Declared household income is divided by declared family size and compared per-capita to per-capita, firing only on a wide multiple. Weight capped low; named first in the cut order.

### 6. Restored a realistic timeline
**Problem:** Round 2 shrank 6-8 weeks back to 4-6 because Java was dropped — but that removed learning curve, not scope. Three services, five signals, dashboard, auth, seed generator and deploy was the same pile. Removing the buffer week was a regression.
**Fix:** **6 weeks core + 1 buffer**, with the Tier-1 engine front-loaded to Week 2 and a stated cut order that protects the core path (Tier 4 locality → Tier 5 tips → household graph visualization, engine retained).

### 7. Filled the design gaps
**Problem:** Five things were never specified: document storage, the auth model, retention, pipeline failure semantics, and tip-form abuse.
**Fix:**
- **Storage:** MinIO locally / S3-R2 in deploy; short-TTL signed URLs, never a public bucket, never Postgres blobs.
- **Auth:** two personas — applicants via passwordless magic link scoped to one application; reviewers/admins invite-only with RBAC. Scores and flags never appear on applicant-facing endpoints, enforced at the serializer with a test asserting it.
- **Retention:** documents purged a configured interval after terminal decision via scheduled job; `audit_log` keeps decision, reason, reviewer, and document hash — never the document.
- **Pipeline:** idempotent handlers keyed on `(document_id, stage)`, per-stage result persistence so retries resume rather than restart, exponential backoff, and a dead-letter queue surfaced in the admin UI. Stage 4 re-runs for every application in an affected household component when a new application joins it.
- **Tips:** per-IP and global rate limits, hashed-IP retention only, capped scoring weight, reviewer-markable as abusive.

### 8. Added a threat model and voice rewrite
**Problem:** No security section at all; and the report was written in third person about "the user," reading as a document authored *for* the project owner rather than *by* them.
**Fix:** New §11 threat model table (malicious upload, application enumeration, score leakage, tip abuse, out-of-process reviewer action, rule tampering). Whole document rewritten in first person / product voice, ready to become a README. Also added to §14: real deployment would need DPDP Act review, an institutional data-processing agreement, and an applicant appeals mechanism — none in scope, and the README will say so.

## Net effect (Round 3)
The differentiated engine is now the centre of the project rather than a footnote, the honesty about validation has been converted from disclaimers into measured numbers with a git-provable methodology, the one legally ambiguous component is gone with its architecture story intact, and the five unspecified subsystems (storage, auth, retention, failure semantics, abuse) are specified. The timeline reflects the actual scope.

---

# Week 4 — findings from opening the measurements

Building the OCR and forensics stage produced three results the design did not predict. All three came from mechanisms that were built to be capable of producing bad news, which is the only reason they were detectable.

## W4-1. ELA carries no usable signal on this corpus

**Finding:** Error Level Analysis separates tampered from untampered documents at **AUC 0.510** — chance. Mean tamper score 0.153 on tampered documents, 0.151 on matched controls. It does not localise the edit either: the strongest ELA region falls in the income band on 12% of tampered documents versus 18% of controls, which is worse than the controls.

**Why it happened:** exactly what §7.3 was written to guard against, working as designed. The tamper path re-encodes through Skia while the rest of the pipeline uses libvips, and degradation then re-compresses the *whole page* on top of the edit at quality 65–85 — lower than the edit's own 88. The final compression dominates and erases the local history ELA reads.

**What changed:** nothing in the detector. The number is published in the README, and `tests/test_forensics.py::test_ela_does_not_separate_tampered_from_control` asserts the AUC stays in a chance band so the figure cannot drift away from the code. If a future detector genuinely separates the groups, that test fails and the README must be updated rather than the bound widened.

**What this vindicates:** the control group. Without a set carrying identical compression history and no edit, a tampered-only measurement would have produced some number — 17 documents scoring a mean 0.153 — and nothing would have revealed that untampered documents score the same.

## W4-2. Holdout recall is 17.6%, not the 100% the known corpus suggests

**Finding:** against `patterns.holdout.ts`, sealed in commit `ac4aad0` before any rule code existed, the engine surfaces **6 of 34** applications it should. Against the known corpus the rules were written for, it surfaces 17 of 17.

**Why it happened:** the rule set covers one family of fraud — income contradictions within a resolved household — and the sealed set contains six others it has no rule for: income bunching just below the ceiling, certificate serial adjacency, one certificate reused across applicants, family-size inflation, shared contact details across nominally distinct households, and deliberate household splitting.

**What changed:** the figure is published as the headline accuracy number, with known recall labelled explicitly as a consistency check rather than evidence. No rules were written to close the gap.

**Why no rules were written:** the holdout is now spent. Its patterns are known to the author, so any rule written against them can no longer be validated by them — that would measure memorisation, which is the exact failure the seal existed to prevent. Closing this gap honestly requires sealing a new set *before* writing those rules.

## W4-3. Confidence filtering silently truncated numbers

**Finding:** dropping Tesseract words below confidence 30 before assembling field values corrupted them rather than omitting them. `Rs. 1,78,000/-` came back as `Rs. 1,78,` because the final token scored 27, parsing cleanly to the wrong amount; certificate numbers lost their last group.

**Why it mattered:** a truncated number is more dangerous than a low-confidence one. It arrives looking like a valid declaration, where a low-confidence read at least arrives labelled uncertain — and the household engine's income-contradiction rules act directly on that value.

**What changed:** `app/ocr.py` now keeps every word Tesseract returns as text and reports per-field confidence instead. Filtering is the consumer's decision, and it can only make it if nothing was discarded first. Field accuracy went from 89.3% to **92.5%**, and documents fully correct from 61% to 70%.

## W4-4. Extraction boxes were in the wrong coordinate space

**Finding:** a test asserting boxes fall within the page caught that they were reported in *deskewed* coordinates. Deskew rotates with `expand=True`, so the levelled page is larger than the original and a box could have x beyond the original width.

**What changed:** `deskew.to_original_coordinates` maps boxes back through the inverse rotation, so a reviewer's overlay drawn on the stored document lands in the right place. Coordinates that only make sense against a discarded intermediate are worse than useless — they look authoritative while being wrong.
