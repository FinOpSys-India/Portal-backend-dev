-- 25_add_custom_plan_requests.sql
--
-- One row each time a user clicks "Connect with us" for a custom service plan.
--
-- request_type says what the click was:
--   NEW       first request for the company — emails sent
--   REPEAT    clicked again within 24h of the last emailed request — no emails
--   FOLLOW_UP clicked again after 24h — emails sent, marked as a follow-up
-- A NEW/FOLLOW_UP row is written only after the support email has gone out.
--
-- A plain record of the request: which company, who asked, and when. Company
-- and user details are NOT copied here — they already live in `companies` and
-- `users`, and the emails sent on request read them from there.
--
-- Safe to re-run: every statement is guarded.

BEGIN;

CREATE TABLE IF NOT EXISTS custom_plan_requests (
  id         SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  request_type VARCHAR(20) NOT NULL DEFAULT 'NEW'
    CHECK (request_type IN ('NEW', 'REPEAT', 'FOLLOW_UP')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS custom_plan_requests_company_id_idx
  ON custom_plan_requests(company_id);

-- For tables created before request_type existed.
ALTER TABLE custom_plan_requests
  ADD COLUMN IF NOT EXISTS request_type VARCHAR(20) NOT NULL DEFAULT 'NEW'
  CHECK (request_type IN ('NEW', 'REPEAT', 'FOLLOW_UP'));

COMMIT;
