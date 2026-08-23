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
