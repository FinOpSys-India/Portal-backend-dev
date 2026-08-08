-- 16_add_company_teammates.sql
--
-- The owner's "Teammates" screen: invite people onto one or more of your
-- companies, then list the teammates attached to a given company.
--
-- WHAT ALREADY EXISTED, and is therefore NOT recreated here:
--
--   company_members(id, company_id, user_id, created_at) UNIQUE(company_id,
--   user_id) — the customer-to-company membership link. This is what the
--   teammate list reads and what sign-up writes. It was absent from
--   prisma/schema.prisma, which is why no code had ever used it; that half is
--   fixed in the Prisma schema, not here.
--
--   invitations.company_id — a single nullable company reference.
--
-- WHAT WAS MISSING, and is what this file adds:
--
--   1. An invitation records a role but no JOB TITLE, and the teammate form
--      collects one. Without a column the title is lost between invite and
--      sign-up, and the invitee has to type it again.
--   2. The form lets an owner tick SEVERAL companies in a single invite, and
--      `invitations.company_id` is ONE column. A column cannot hold a set, and
--      issuing one invitation row per company would mean several live tokens for
--      one address — which createInvitation deliberately prevents, since it
--      replaces prior invitations per email.
--
-- So: one column, one join table.
--
-- `invitation_companies` is the INTENT (the companies an invitation is for,
-- before it is accepted); `company_members` is the FACT (the companies a real
-- user is on, after). Sign-up copies the first into the second — see
-- services/authService.signup.
--
-- Safe to re-run: every statement is guarded.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 1. invitations.job_title                                                   */
/* -------------------------------------------------------------------------- */

-- Nullable, because every invitation created before this migration has no title
-- and NOT NULL would mean inventing one. VARCHAR(150) matches users.job_title,
-- so the value copies across at sign-up without truncation.
ALTER TABLE invitations
  ADD COLUMN IF NOT EXISTS job_title VARCHAR(150);

/* -------------------------------------------------------------------------- */
/* 2. invitation_companies — the companies an invitation is for               */
/* -------------------------------------------------------------------------- */

-- CASCADE on both sides. On the invitation, because these rows describe it and
-- mean nothing without it — createInvitation deletes stale invitations when
-- re-inviting an address, and those deletes must take their company links along.
-- On the company, because an invitation to join a company that no longer exists
-- is not worth keeping, and the invitation row itself survives.
--
-- The composite primary key IS the "each company listed once per invitation"
-- rule: a form that posts the same company twice collapses to one row rather
-- than producing a duplicate the read side would have to filter out.
CREATE TABLE IF NOT EXISTS invitation_companies (
  invitation_id INTEGER NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
  company_id    INTEGER NOT NULL REFERENCES companies(id)   ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (invitation_id, company_id)
);

-- Supports "which invitations are outstanding for this company?", which the
-- teammate screen asks in order to show pending rows beside accepted ones. The
-- primary key already serves the invitation-first direction.
CREATE INDEX IF NOT EXISTS invitation_companies_company_id_idx
  ON invitation_companies(company_id);

/* -------------------------------------------------------------------------- */
/* 3. Backfill from the single-company column                                 */
/* -------------------------------------------------------------------------- */

-- Every invitation that already names a company gets the equivalent row here, so
-- the join table is the ONE place to read from and no caller has to check both.
-- `invitations.company_id` is left in place and is not written to again —
-- superseded, not dropped, so nothing that still reads it breaks.
INSERT INTO invitation_companies (invitation_id, company_id)
SELECT i.id, i.company_id
  FROM invitations i
  JOIN companies c ON c.id = i.company_id
 WHERE i.company_id IS NOT NULL
ON CONFLICT DO NOTHING;

COMMIT;
