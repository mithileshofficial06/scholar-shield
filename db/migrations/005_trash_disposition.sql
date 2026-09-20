-- A fourth disposition: trash.
--
-- Approve, escalate and reject all presume an application that was made in good
-- faith. Some are not: random details typed into the form and an unrelated file
-- attached as the "certificate". Rejecting those pollutes the reject rate, which
-- a committee reads as "applications we turned down", and it makes every real
-- refusal harder to defend in an audit.
--
-- Trash is terminal and reasoned exactly like a rejection — same reviews row,
-- same mandatory written reason, same append-only audit log. It differs in one
-- respect only: it leaves the working queue and the decided list, so nobody
-- works the same junk twice. It is a reviewer's judgement, never the pipeline's;
-- no rule and no score can set it.
--
-- ADD VALUE is safe inside the runner's implicit transaction on PostgreSQL 12+
-- because nothing here writes the new value.

ALTER TYPE application_status ADD VALUE IF NOT EXISTS 'trashed';
ALTER TYPE review_decision ADD VALUE IF NOT EXISTS 'trash';
