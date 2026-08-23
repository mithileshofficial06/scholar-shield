# ScholarShield — Project Report
### Scholarship Fraud Risk-Triage Platform

---

## 1. Context & Motivation

The user observed a real, recurring problem in Indian college scholarship programs: students from financially well-off families (household income well above ₹10 LPA) obtain fraudulent income certificates — declaring incomes as low as ~₹72,000/year — to fraudulently qualify for scholarships meant for economically weaker students.

This is a documented, ongoing issue, not a hypothetical:
- Tripura's government issued show-cause notices / pursued FIRs against 34 students for submitting fake documents to claim post-matric scholarships ([Deccan Herald](https://www.deccanherald.com/amp/story/india%2Ftripura%2Ftripura-govt-issues-show-cause-notices-34-st-students-who-submitted-fake-docs-to-get-scholarship-3475877), [Careers360](https://news.careers360.com/tripura-government-issues-show-cause-notices-34-st-students-who-submitted-fake-documents-get-post-matric-scholarship/amp)).
- Case law on false income certificates submitted for scholarship purposes exists across Indian courts ([CaseMine](https://www.casemine.com/search/in/false+income+certificate+for+scholarship)).
- Submitting a fake certificate is a criminal offence (forgery + defrauding a public authority) with real legal consequences ([Sudhir Rao — Legal Consequences](https://sudhirrao.com/legal-consequences-of-faking-income-for-a-scholarship-in-india/), [LawRato](https://lawrato.com/civil-legal-advice/punishment-for-producing-fake-income-certificate-to-get-rebate-in-fee-245367)).
- Current "verification" is almost entirely **reactive**: the [National Scholarship Portal](https://scholarships.gov.in/) relies on manual review by Tehsildars / State & District Nodal Officers at intake, and fraud is typically only caught later via police investigation, if at all.

**The gap:** several Indian states already run a public, standalone certificate-authenticity lookup (enter a certificate/application number, get back whether it's genuine) — e.g. Tamil Nadu's e-District [`VerifyCerti`](https://tnedistrict.tn.gov.in/tneda/VerifyCerti.xhtml) portal, Digital Gujarat's [certificate verification portal](https://portal.digitalgujaratscholarships.com/certificate-verification-gujarat/). But **no tool integrates that lookup into an actual scholarship committee's review workflow**, and nothing cross-references applications against each other to catch the more common fraud pattern — a certificate that is technically "genuine" (properly issued) but declares an income that misrepresents the family's real financial position, or is inconsistent with a sibling's separately filed application.

## 2. What Already Exists (and why it isn't enough)

| Existing mechanism | What it does | Limitation |
|---|---|---|
| State e-District certificate lookups (TN `VerifyCerti`, Digital Gujarat) | Confirms a certificate ID was genuinely issued | Standalone tool; nobody wires it into scholarship review; doesn't catch a *genuinely issued* certificate with a misleading declared income |
| NSP manual review (Tehsildar / Nodal Officer) | Human checks documents at intake | No cross-application analysis, no anomaly detection, no document forensics; relies entirely on one reviewer's judgment |
| Post-hoc FIR / legal action | Punishes fraud after the fact | Doesn't prevent the scholarship from being wrongly awarded in the first place; slow, resource-intensive, rare |
| Commercial KYC APIs (e.g. SurePass-style income-certificate verification) | Sell certificate-authenticity checks to businesses | Not built for or accessible to college scholarship committees; no workflow layer |

**Conclusion: this is a genuine, unaddressed gap and worth building.** The opportunity is specifically the *triage layer* — something that sits between document upload and human decision, using signals that are legally and practically available to a college (not government-restricted data).

## 3. Proposed Solution

**ScholarShield** — a decision-support platform for college scholarship committees. It ingests submitted income certificates and applicant data, and produces an **explainable risk score** to prioritize which applications a human reviewer should scrutinize first. It does **not** auto-approve or auto-reject anyone.

### 3.1 Guardrails (non-negotiable, enforced in the design, not just policy)

1. **No automated verdicts.** Every score is framed as "flag for review," never "fraud detected." No workflow path exists for the system to reject an application on its own.
2. **No unauthorized government data access, and manual verification is the primary path, not a fallback.** The system only queries the *public, unauthenticated* TN certificate-verification lookup, rate-limited and respectful of the portal's load. Automated querying of a government portal carries genuine ToS/legal ambiguity in India, and TN's `VerifyCerti` portal likely has CAPTCHA/anti-automation protection — so the design assumes automation may not be reliably available and treats the **pre-filled manual-verification link** as the primary, demo-safe path a reviewer always has, with automated lookup attempted opportunistically as an enhancement on top of it, never the other way around. The system never fakes or guesses a verification result.
3. **Synthetic data only.** All demo applicants, families, and certificate images are generated by a seed script (some genuine, some deliberately tampered, some internally contradictory, and some legitimate-but-anomalous — see §3.3). No real student's real documents are ever used.
4. **Full audit trail.** Every reviewer decision (approve/escalate/reject) requires a typed reason and is permanently logged — this is what makes "decision support, not verdict" a credible design rather than just marketing language.

### 3.2 Risk Signals (all explainable, no black-box ML in v1)

1. **Document forensics** — Error Level Analysis (ELA) and file-metadata consistency checks on the uploaded certificate image/PDF to flag likely tampering (edited text, copy-pasted stamps, mismatched fonts). *Caveat: ELA has a known false-positive rate on ordinary JPEG recompression, not just tampering — see §9.*
2. **Certificate-authenticity check** — a pre-filled **manual-verification link** to TN's public `VerifyCerti` portal is always generated and shown to the reviewer (the guaranteed, demo-safe path); an automated lookup adapter attempts the same check first and fills in the result when it succeeds. Designed so Gujarat/Karnataka/etc. can be added later without touching the rest of the system.
3. **Cross-application consistency** — flags families where: siblings' separately submitted applications declare different incomes; the same address appears across supposedly unrelated "low-income" applicants (possible collusion); a certificate was issued suspiciously close to the application deadline (a known fraud pattern — last-minute certificate shopping). *Caveat: each of these has legitimate explanations too — see §3.3.*
4. **Locality income-band anomaly** — declared income compared against a small static reference table of district-level per-capita income, sourced from the [data.gov.in Open Government Data Platform's "District wise Per Capita Income" datasets](https://www.data.gov.in/catalog/district-wise-capita-income-current-prices) (current and constant prices, published under NDSAP). Confirmed to exist and be downloadable as a real public dataset, so this ships in v1 as planned — used purely as a soft signal, never a determination, and re-imported periodically rather than treated as always current.
5. **Anonymous tip intake** — a lightweight whistleblower form (peers/staff can flag a case) that routes into the same review queue as a distinct, clearly-labeled flag type.

Each signal contributes to a **versioned, weighted rule engine** (not a trained model for v1 — this keeps every score fully explainable, which matters both ethically and for the interview story). A future-work note in the report calls out that an anomaly-detection model (e.g. isolation forest) could be layered on later as a *secondary* signal, never a replacement for the explainable rules.

### 3.3 Equity & False-Positive Considerations

A triage system whose subject is "which economically vulnerable applicants look suspicious" carries a real risk of systematically flagging applicants whose circumstances are irregular but not fraudulent. This is treated as a first-class design constraint, not an afterthought:

- **Known legitimate triggers to design around:** a recent death or job loss of an earner (sudden income drop with no paper trail yet), a family relocation (address mismatch across records), siblings applying in the same admission cycle (certificates issued close together is normal, not evidence of "certificate shopping"), remarriage or custody changes affecting registered address.
- **Mitigations:**
  - Every flag ships with a human-readable reason string and its contributing signal weights — a reviewer sees *why*, not just a number, so a flagged-but-legitimate case is fast to clear rather than defaulting to suspicion.
  - The synthetic seed dataset (§3.1) deliberately includes legitimate-but-anomalous cases (bereavement, relocation, same-cycle sibling filings) alongside genuine and tampered ones.
  - No flag type is permitted to auto-escalate priority beyond "review sooner" — a high score changes queue order, never applicant-facing outcome, and never bypasses the typed-reason audit requirement.
- **This is tested, not just claimed.** A named, standalone test suite — `apps/api/test/equity.regression.test.ts` — asserts that every legitimate-but-anomalous synthetic case in the seed dataset produces no high-severity flag. This suite is called out by name in the README (not folded silently into general rule-engine tests) specifically so it's independently checkable and demoable, e.g. `npm test -- equity.regression`.
- **Open question, stated honestly:** this project cannot claim a validated false-positive rate against real applicants (see §9) — the equity mitigations above reduce *known* risk patterns but are not a substitute for real-world evaluation before any actual deployment.

## 4. Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Frontend (applicant upload + admin dashboard) | **Next.js** (TypeScript, App Router) | Dashboard-heavy UI with server components for the risk queue; matches the user's existing strength (used in Vaxi-Track/CodeMap/InboxIQ) |
| Backend API / orchestration | **Express** (TypeScript) | REST API, auth, BullMQ job production, adapter orchestration — reuses the user's existing Express experience |
| OCR + image forensics microservice | **Python (FastAPI)** + Tesseract/EasyOCR + Pillow/NumPy (ELA) | Python's CV/OCR ecosystem is materially better here than Node's; this is the one deliberate *new* skill added to the resume (polyglot service architecture), kept isolated to the one layer that genuinely needs it |
| Database | **PostgreSQL** | Relational integrity for applicants/applications/documents/audit trail; well-understood, already used in InboxIQ |
| Job queue | **Redis + BullMQ** | Async pipeline for OCR → forensics → verification → scoring, matching the pattern already proven in InboxIQ's Gmail sync pipeline |
| Deployment | **Vercel** (web) + **Railway/Render** (API, worker, Postgres, Redis) or a single Docker Compose VPS | Low-friction, matches deployment patterns already on the user's resume |
| Containerization | **Docker Compose** for local dev | One-command bring-up of Postgres + Redis + all three services |

### Why not pure Node end-to-end?
The user chose Next.js + Express + a Python microservice specifically to add OCR/CV depth (Python's Tesseract/OpenCV ecosystem is stronger) without abandoning their Node strengths for the rest of the app. Python/FastAPI is kept as the **only** new ecosystem in this project — an earlier draft of this report also swapped the backend to Java/Spring Boot, which would have made this a three-ecosystem build; that was reverted specifically to keep schedule risk down to the one layer (OCR/CV) that actually requires a new skill, rather than adding a second new stack that doesn't buy anything the existing Express experience doesn't already cover.

## 5. System Architecture

```
scholarshield/
  apps/
    web/            Next.js — applicant upload flow (synthetic demo) + admin review dashboard
    api/             Express — REST API, auth, BullMQ producer, risk-scoring orchestration
                     test/equity.regression.test.ts — named equity/false-positive test suite (§3.3)
    ocr-service/     Python (FastAPI) — OCR field extraction + image forensics (ELA, metadata)
  packages/
    shared/          Shared TS types (Application, Document, RiskFlag, etc.)
  infra/
    docker-compose.yml   Postgres + Redis + all three services for local dev
  db/
    migrations/      SQL migrations (users, applicants, applications, documents,
                      verification_results, risk_flags, reviews, audit_log)
    seed/            Synthetic data generator (genuine + tampered + contradictory +
                      legitimate-but-anomalous samples — see §3.3)
```

**Processing pipeline** (BullMQ job triggered on document upload):

1. **OCR extraction** (Python service) → structured fields: name, declared income, certificate ID, issuing authority, issue date
2. **Image forensics** (Python service) → ELA heatmap + metadata consistency check → tamper-likelihood score
3. **Certificate verification** (Express, `CertificateVerificationAdapter` interface) → generates the manual-verification link immediately (always available) → attempts automated `VerifyCerti` lookup → `verified | mismatch | manual_check_required` (+ link)
4. **Cross-application consistency engine** (Express/Postgres) → sibling contradiction detection, address clustering, deadline-proximity check
5. **Explainable risk scorer** → weighted rule engine (versioned config) → `RiskFlag` rows, each with a human-readable reason string
6. Result appears in the **admin risk queue**, sorted by score, fully drillable into "why"

**Admin dashboard (Next.js):**
- Risk queue — sortable/filterable by score and flag type
- Application detail — extracted fields, forensics heatmap overlay, verification status, consistency flags, full reasoning trail
- Reviewer actions — approve / escalate / reject, each requiring a typed reason → written to `audit_log`
- Anonymous tip form — separate intake, routes into the same queue as a distinct flag type

### Core database tables
`users` (admin/reviewer roles) · `applicants` · `applications` · `documents` · `verification_results` · `risk_flags` (score + reason + rule version) · `reviews` · `audit_log`

## 6. Milestones (4–6 weeks)

With Python/FastAPI as the only new ecosystem, the original 4–6 week estimate holds.

1. **Week 1 — Scaffold**: repo init, Docker Compose (Postgres+Redis), DB schema/migrations, Express skeleton with role-based auth, Next.js skeleton with upload form + empty dashboard shell.
2. **Week 2 — OCR pipeline**: Python FastAPI service (Tesseract/EasyOCR) for field extraction; wired into Express via BullMQ; extracted fields persisted.
3. **Week 3 — Forensics + verification**: ELA tamper detection + metadata checks; manual-verification-link generation shipped first (§3.1), with the automated `VerifyCerti` adapter layered on as an enhancement; synthetic dataset generator (genuine/tampered/contradictory/legitimate-but-anomalous samples).
4. **Week 4 — Consistency + scoring**: cross-application consistency engine; versioned explainable risk-scoring rule engine; unit tests asserting specific synthetic inputs produce specific flags, plus the named `equity.regression.test.ts` suite (§3.3) asserting legitimate-but-anomalous inputs do NOT produce high-severity flags; import the data.gov.in district income dataset for signal #4.
5. **Week 5 — Review workflow**: risk queue UI, detail/explanation view, reviewer decision + audit trail, anonymous tip form.
6. **Week 6 — Polish & deploy**: tests, README (with an explicit Limitations & Ethics section, linking the equity test suite by name), deployment, seeded demo dataset, scripted demo walkthrough for interviews — including a recorded screen capture of the automated `VerifyCerti` lookup succeeding at least once, so the live demo never depends on the portal's CAPTCHA behavior working on demand.

## 7. Verification Plan

- Unit tests for the risk-scoring rule engine against fixed synthetic inputs (expected flags/scores).
- **Named equity regression suite** (`equity.regression.test.ts`, §3.3): fixed legitimate-but-anomalous synthetic inputs asserted to NOT produce high-severity flags — run and reported separately from general rule-engine tests, not folded in.
- Integration test: upload synthetic document → job completes → correct `RiskFlag` rows created.
- Manual QA pass through the full flow: applicant upload → admin review → decision → audit log, including the case where automated `VerifyCerti` lookup fails/CAPTCHAs and the manual-link path is exercised instead.
- `docker-compose up` brings up the full stack locally for live demoing (important for interviews — this should just work on a laptop).

## 8. Why This Is a Strong Resume Project

- **Not another AI-wrapper CRUD app** — it forces real engineering across OCR/CV, anomaly detection, async pipelines, and a polyglot service boundary.
- **Grounded in real research**, not a toy prompt — the report above cites actual government portals, real fraud cases, and a real public income dataset (data.gov.in), which is a strong interview narrative ("I researched how income certificates are actually verified in India before writing a line of code").
- **Demonstrates responsible system design** — the explainability + human-in-the-loop + audit-trail + equity-by-design (§3.3, tested not just claimed) constraints show judgment senior engineers look for, not just the ability to call an LLM API.
- **One deliberate new skill, not schedule-risk sprawl** — Python/FastAPI for OCR/CV is the single new ecosystem, chosen because it's the layer that actually benefits from it; the rest of the stack reuses proven strengths, which keeps the 4–6 week estimate credible instead of optimistic.
- **Extends existing resume strengths** (CodeMap's analysis engine mindset, InboxIQ's async job pipeline pattern, the security-scanner hackathon project and Google Cybersecurity cert) into one cohesive flagship piece.

## 9. Known Limitations (stated up front, not discovered later)

- Cannot verify a family's *actual* income against ground truth (no legal access to IT/property records) — the system flags risk signals, it does not prove fraud.
- TN's `VerifyCerti` portal likely has CAPTCHA/anti-automation protection; full automation may not be possible — this is why the manual-assist link is the primary path (§3.1), not a fallback bolted on after the fact.
- V1 ships with one state (Tamil Nadu) integrated; the adapter pattern is designed for others to be added later without a rewrite.
- **The rule engine is validated only against synthetic data generated to match its own detection patterns.** This demonstrates internal consistency (it catches the fraud patterns it was designed to catch), not real-world precision/recall — there is no real, fraud-labeled dataset to validate against, and this project cannot produce one. Any precision/recall claim made in a demo or interview should be scoped explicitly to "against the synthetic test set," never generalized.
- ELA-based forensics specifically has a known false-positive rate on ordinary JPEG recompression artifacts, independent of actual tampering — flagged documents are a prioritization signal, not evidence.
- Cross-application and locality signals can trigger on legitimate life circumstances, not just fraud (§3.3) — the equity mitigations in this report reduce known risk patterns and are covered by a named regression test suite, but have not been validated against real applicants.
- The district income-band reference table (data.gov.in, §3.2 signal 4) is a periodically re-imported static dataset, not a live feed — district-level averages also mask intra-district variation, which is why this signal is weighted as soft, not determinative.

---

## 10. First Implementation Step (once approved)

Scaffold the repo at `C:\Users\msaje\Desktop\scholarshield`: git init, the folder structure in §5, Docker Compose for Postgres+Redis, DB migrations for the core schema, an Express skeleton with a health check + auth stub, a Next.js skeleton with a placeholder upload form and dashboard shell, and a root README containing this report's problem statement, ethics stance, and a pointer to the named `equity.regression.test.ts` suite (§3.3). This gives a running, committable Week-1 foundation.
