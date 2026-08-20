-- 19_add_email_messages.sql
--
-- The compose-and-send email screen: a From, a Subject, a Body, and any number
-- of attached files.
--
-- APPLIED BY HAND in the Supabase SQL editor. This file is the record of that
-- change and matches it statement for statement.
--
-- NOT RE-RUNNABLE, unlike the other files here. `CREATE TYPE` has no
-- IF NOT EXISTS and the usual DO/EXCEPTION guard was dropped so the script could
-- be pasted into the SQL editor without the block delimiters getting mangled.
-- The whole thing runs in one transaction, so a failure rolls back with nothing
-- half-created; a SECOND run simply errors on the first CREATE TYPE and changes
-- nothing.
--
-- WHAT ALREADY EXISTED, and is therefore NOT recreated here:
--
--   src/services/emailService.js — a configured nodemailer transport that
--   already sends invitation and OTP mail. It fires and forgets: nothing
--   recorded that a message was composed, who it went to, or whether the
--   provider accepted it. That is the gap this closes.
--
--   src/utils/storage.js — the one place bytes become stored objects. It deals
--   only in KEYS ("projects/5/1a2b.pdf") and resolves them against local disk or
--   a Supabase bucket. Attachments below reuse it unchanged, under a new
--   "emails/outbox/<sender_user_id>/<random>.<ext>" prefix in the SAME private
--   documents bucket (config.storage.documentsBucket). No new bucket, no new
--   config. The prefix names the SENDER rather than the message because the file
--   is uploaded before any message exists — see decision 3 below.
--
-- FOUR DECISIONS WORTH STATING
--
--   1. THE BYTES ARE NOT IN THE DATABASE, for the reasons set out at length in
--      18_add_project_documents.sql. Metadata in Postgres, bytes in the bucket,
--      joined by `file_key`.
--
--   2. NOTHING IS STORED THAT A JOIN ALREADY ANSWERS. There is no `from_email`
--      or `from_name` beside `sender_user_id`, and no `email` or `name` on a
--      recipient beside `user_id` — those come from `users`. Recipients are
--      picked from the company's own roster (its owner, its teammates on
--      company_members, its assigned specialists), so every one of them IS a
--      row in `users`. The day the screen accepts a free-form outside address,
--      `email_recipients` needs `email VARCHAR(255)` back and `user_id`
--      nullable; until then the column would be NULL-or-duplicate on every row.
--
--   3. THE STATUS ENUM HAS THREE VALUES, NOT FIVE. No QUEUED, no SENDING:
--      emailService hands the message to nodemailer inline in the request, so
--      nothing ever rests in an in-flight state long enough to be queried for.
--      FAILED is retryable, and `error_message` is what makes the retry a
--      judgement rather than a guess — "mailbox does not exist" (never retry,
--      tell the user) and "SMTP timeout" (retry) are indistinguishable without
--      it.
--
--      DRAFT IS A COLUMN DEFAULT AND NOTHING ELSE. There is no draft in the
--      API: `POST /emails` inserts the row, attaches the uploaded files and
--      hands the message to SMTP inside one request, so a row is SENT or FAILED
--      by the time that request returns. The value is what the row carries for
--      the duration of the SMTP handshake, which is also what makes it useful —
--      a process killed mid-send leaves a row that is visibly neither, and the
--      retry endpoint accepts it. Nothing queries for DRAFT and the list
--      endpoint refuses it as a filter.
--
--      It is kept in the enum rather than dropped because removing a value from
--      a Postgres enum is a rewrite of the type and every dependent column, to
--      delete a state that costs nothing and is the honest name for "not sent
--      yet".
--
--   4. RECIPIENTS ARE ROWS, NOT A COMMA-SEPARATED COLUMN, and the composite
--      primary key IS the identity — no surrogate id, no created_at duplicating
--      the message's own. Keyed on recipient_type as well as user, because
--      putting someone on both TO and CC of one message is a real thing to do
--      and the mail header carries both.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 1. Enums                                                                   */
/* -------------------------------------------------------------------------- */

CREATE TYPE email_status AS ENUM ('DRAFT','SENT','FAILED');
CREATE TYPE email_recipient_type AS ENUM ('TO','CC','BCC');

/* -------------------------------------------------------------------------- */
/* 2. email_messages — the From / Subject / Body                              */
/* -------------------------------------------------------------------------- */

CREATE TABLE email_messages (
  id             SERIAL PRIMARY KEY,

  -- Which company the message is filed under, and what the list screen filters
  -- by. SET NULL rather than CASCADE on both references below: the record that
  -- a message was sent is an audit fact that outlives the account it was about
  -- and the staff member who wrote it. Offboarding must not erase sent mail.
  company_id     INTEGER REFERENCES companies(id) ON UPDATE CASCADE ON DELETE SET NULL,
  sender_user_id INTEGER REFERENCES users(id)     ON UPDATE CASCADE ON DELETE SET NULL,

  -- 500, not 255: RFC 5322 sets no subject limit and clients accept several
  -- hundred characters. Silently truncating a user's subject line is a loss
  -- they cannot see coming.
  subject        VARCHAR(500) NOT NULL,

  -- TEXT, not VARCHAR(n) — a body has no natural maximum and Postgres stores the
  -- two identically, so a cap could only ever reject a long email, never save a
  -- byte. HTML only; the plain-text alternative part is generated at send time
  -- rather than stored, since it is derivable and would drift once edited.
  body_html      TEXT         NOT NULL,

  status         email_status NOT NULL DEFAULT 'DRAFT',

  -- The transport's rejection, verbatim. See decision 3 above.
  error_message  TEXT,
  sent_at        TIMESTAMPTZ,

  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- The state machine, enforced where no code path can bypass it: SENT means
  -- there is a send time, and nothing else may carry one.
  CONSTRAINT email_messages_sent_at_matches_status
    CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
);

-- The list screen: one company's messages, newest first. Carries created_at DESC
-- so the ORDER BY is served by the index and no sort step runs.
CREATE INDEX email_messages_company_created_idx
  ON email_messages(company_id, created_at DESC);

/* -------------------------------------------------------------------------- */
/* 3. email_recipients — TO / CC / BCC                                        */
/* -------------------------------------------------------------------------- */

-- CASCADE on the message: recipients describe it and mean nothing without it.
-- CASCADE on the user too, unlike the sender above — a recipient row with a
-- dangling NULL user names nobody at all, whereas the message itself still
-- records what was sent.
CREATE TABLE email_recipients (
  email_message_id INTEGER NOT NULL REFERENCES email_messages(id) ON UPDATE CASCADE ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id)          ON UPDATE CASCADE ON DELETE CASCADE,
  recipient_type   email_recipient_type NOT NULL DEFAULT 'TO',

  -- Also the "recipients of this message" lookup path, since it leads with
  -- email_message_id — which is why no separate index on that column exists.
  PRIMARY KEY (email_message_id, user_id, recipient_type)
);

-- The other direction: "every email this person received".
CREATE INDEX email_recipients_user_id_idx ON email_recipients(user_id);

/* -------------------------------------------------------------------------- */
/* 4. email_attachments                                                       */
/* -------------------------------------------------------------------------- */

CREATE TABLE email_attachments (
  id               SERIAL PRIMARY KEY,
  email_message_id INTEGER      NOT NULL REFERENCES email_messages(id) ON UPDATE CASCADE ON DELETE CASCADE,

  -- The generated storage key, e.g. "emails/outbox/42/9f3c…b1.pdf" — where 42 is
  -- the SENDER, not this message. UNIQUE for the same reason
  -- project_documents.file_key is, with one extra job here: the browser uploads
  -- before a message exists, so this index is also what stops the same uploaded
  -- object being attached to two different messages by a replayed POST /emails.
  --
  -- There is deliberately no project_document_id alternative. Attaching an
  -- existing project document copies it to a new key instead, so a document
  -- soft-deleted from its project cannot make a sent message's attachment list
  -- render blank. Add the column if that copy ever becomes too expensive.
  file_key         VARCHAR(512) NOT NULL UNIQUE,

  -- The name the file arrived with, shown back to the user. NEVER used to build
  -- a path: it is attacker-controlled, and "../../server.js" is a perfectly
  -- ordinary string in this column.
  original_name    VARCHAR(255) NOT NULL,
  mime_type        VARCHAR(150) NOT NULL,

  -- BIGINT for the reason given in 18: the size cap is configuration, INTEGER
  -- tops out at 2 GB, and a column widened later is a migration on a large
  -- table. The CHECK is what actually means "there are bytes" — NOT NULL alone
  -- would accept a zero-byte file, which is a failed upload, not a document.
  size_bytes       BIGINT       NOT NULL CHECK (size_bytes > 0)
);

-- The only access path: "the attachments on this message". `file_key` needs no
-- index of its own — the UNIQUE constraint already built one.
CREATE INDEX email_attachments_message_id_idx ON email_attachments(email_message_id);

COMMIT;
