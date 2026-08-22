-- 20_add_chat.sql
--
-- Company-scoped 1:1 chat between the accounting manager and the people on that
-- company's account — its customers (the owner and their teammates) and its
-- specialists. Messages carry text, attachments (documents/images) that can be
-- downloaded, a timestamp, and a read receipt.
--
-- APPLIED BY HAND in the Supabase SQL editor, like 19_add_email_messages.sql,
-- and NOT RE-RUNNABLE for the same reason: `CREATE TYPE` has no IF NOT EXISTS
-- and the DO/EXCEPTION guard is dropped so the script survives being pasted into
-- the SQL editor. The whole file is one transaction — a failure rolls back with
-- nothing half-created, and a second run errors on the first CREATE TYPE and
-- changes nothing.
--
-- WHAT ALREADY EXISTS, and is therefore reused rather than rebuilt:
--
--   src/utils/storage.js — the one place bytes become stored objects, dealing
--   only in KEYS. Chat attachments reuse it unchanged under a new
--   "chat/<conversation_id>/<random>.<ext>" prefix in the SAME private documents
--   bucket (config.storage.documentsBucket). No new bucket, no new config. The
--   prefix names the CONVERSATION rather than the message because a file is
--   uploaded before the message row exists.
--
--   The roster tables that decide who may be in a conversation at all:
--   companies.owner_user_id, company_members (teammates), and the specialist
--   links — companies.{bookkeeping,payroll,tax}_specialist_user_id plus
--   company_specialist_assignments. Nothing below duplicates them.
--
-- ============================================================================
-- THE MODEL, AND WHY
-- ============================================================================
--
-- A CONVERSATION is (company, accounting manager, counterpart). Every message
-- hangs off one. Three consequences worth being explicit about:
--
--   1. THE COMPANY IS PART OF THE THREAD IDENTITY, not a filter bolted on top.
--      One person can be a teammate at two companies and a specialist on a
--      third. Without company_id in the unique key their messages would merge
--      into a single stream and one client's books would be discussed in
--      another client's thread. `UNIQUE (company_id, accounting_manager_user_id,
--      participant_user_id)` is what makes "different chats per company" a
--      guarantee rather than a convention.
--
--   2. THE ACCOUNTING MANAGER IS A COLUMN, NOT A JOIN to
--      companies.accounting_manager_user_id. That column says who manages the
--      account TODAY; the thread must say who actually held the conversation.
--      Reassigning a company would otherwise silently rewrite the authorship of
--      every past thread. The rule "the manager must be the one assigned to that
--      company" is a check performed when the conversation is OPENED (service
--      layer, against companies.accounting_manager_user_id) — after that, the
--      row is history and stays as written.
--
--   3. THERE IS NO recipient_user_id ON A MESSAGE. A conversation has exactly
--      two sides, so the receiver is "whichever of the two did not send it" —
--      one CASE expression away and always correct. A stored copy could disagree
--      with the conversation it hangs off, and then no query could say which was
--      right. Same reasoning as email_recipients having no `email` column: see
--      the query at the foot of this file, which returns sender id/email AND
--      receiver id/email for the API payload without storing either.
--
-- NO EMAIL ADDRESSES ARE STORED HERE. sender_user_id resolves to users.email,
-- company_id to companies.company_email. A second copy is either NULL or
-- duplicate on every row, and goes stale the day someone changes their address.
--
-- WHO MAY READ A THREAD — the assigned accounting manager, the counterpart
-- themselves, or an admin — is enforced in the service layer, where the caller's
-- identity comes from the verified token. No CHECK constraint can reach across
-- four tables from here.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 1. Enum                                                                    */
/* -------------------------------------------------------------------------- */

-- The two sections of the accounting-manager portal, and the only thing that
-- tells them apart. It is nearly derivable — a join to users.role_id would say
-- CUSTOMER or SPECIALIST today — and it is stored anyway, deliberately, for the
-- one case where the join gives the wrong answer: a person's role can change
-- (a teammate hired onto the specialist team), and that must not retroactively
-- move a finished thread out of the section it was held in. It also turns each
-- section into a single index scan instead of a three-table join on every load.
--
-- OWNER and TEAMMATE are NOT separate values. The portal's first section lists
-- both together and the distinction is a property of the roster, not of the
-- chat: companies.owner_user_id says which one a person is, and it can change
-- hands without any thread changing meaning.
CREATE TYPE chat_participant_kind AS ENUM ('CUSTOMER','SPECIALIST');

/* -------------------------------------------------------------------------- */
/* 2. chat_conversations — one thread per (company, manager, counterpart)      */
/* -------------------------------------------------------------------------- */

CREATE TABLE chat_conversations (
  id                         SERIAL PRIMARY KEY,

  -- CASCADE: a thread is meaningless without the company it is filed under, and
  -- ordinary company removal is the SOFT delete in 06/12 anyway, which leaves
  -- these rows alone. This only fires on a true DELETE.
  company_id                 INTEGER NOT NULL REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE,

  -- Both sides are NOT NULL: a thread with one identifiable end is not a thread.
  -- RESTRICT rather than SET NULL — deleting a user account that still holds
  -- conversations is blocked, and the app's normal offboarding path is
  -- hibernation (users.hibernated_at / status), which leaves these intact.
  accounting_manager_user_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  participant_user_id        INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,

  participant_kind           chat_participant_kind NOT NULL,

  -- Denormalized on purpose. Both portal sections sort by "most recent activity"
  -- and show a preview line; deriving it would mean a correlated MAX over
  -- chat_messages for every row on every load. Written in the SAME transaction
  -- as the message insert (there are no triggers anywhere in this schema, and
  -- introducing one here would hide the write from the code that performs it).
  -- NULL until the first message, which is exactly "opened but nothing said".
  last_message_at            TIMESTAMPTZ,

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One thread per pair per company. See consequence 1 above. This is also the
  -- index that makes "open or reuse the conversation with X" a single upsert
  -- instead of a select-then-insert race that can create two threads.
  CONSTRAINT chat_conversations_unique_pair
    UNIQUE (company_id, accounting_manager_user_id, participant_user_id),

  -- Nobody chats with themselves. Cheap, and it catches the caller that passes
  -- the manager's own id as the counterpart.
  CONSTRAINT chat_conversations_distinct_sides
    CHECK (accounting_manager_user_id <> participant_user_id)
);

-- The accounting-manager portal, both sections: one company, one kind, newest
-- activity first. Carries last_message_at DESC so the ORDER BY is served by the
-- index and no sort step runs.
CREATE INDEX chat_conversations_company_kind_idx
  ON chat_conversations(company_id, participant_kind, last_message_at DESC);

-- The other direction: the customer's / specialist's own inbox — "every thread
-- I am in", across companies.
CREATE INDEX chat_conversations_participant_idx
  ON chat_conversations(participant_user_id, last_message_at DESC);

-- "Every thread this manager holds", for the manager's own cross-company inbox
-- and for the reassignment audit. The unique constraint above leads with
-- company_id, so it cannot answer this.
CREATE INDEX chat_conversations_manager_idx
  ON chat_conversations(accounting_manager_user_id, last_message_at DESC);

/* -------------------------------------------------------------------------- */
/* 3. chat_messages                                                           */
/* -------------------------------------------------------------------------- */

CREATE TABLE chat_messages (
  -- BIGSERIAL, unlike every other table here. Messages are the one row type in
  -- this system produced by ordinary typing rather than by a business event;
  -- INTEGER's 2.1 billion is a long way off, but a chat table is exactly where a
  -- sequence exhaustion would eventually land, and the migration to fix it later
  -- rewrites the largest table in the database.
  id              BIGSERIAL PRIMARY KEY,

  conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON UPDATE CASCADE ON DELETE CASCADE,

  -- The sender. NOT NULL and RESTRICT for the same reason as the conversation's
  -- two sides: an unattributed message is worse than no message, and the app
  -- hibernates accounts rather than deleting them.
  --
  -- The RECEIVER is deliberately absent — see consequence 3 in the header, and
  -- query C at the foot of this file.
  sender_user_id  INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,

  -- TEXT, not VARCHAR(n): Postgres stores them identically, so a cap could only
  -- ever reject a long message, never save a byte.
  --
  -- NULLABLE, because an attachment with no caption is a perfectly ordinary
  -- message. The CHECK rejects the other case — a whitespace-only body is a
  -- client bug, not a message. "Has text OR has at least one attachment" spans
  -- two tables and is enforced in the service layer, inside the transaction that
  -- writes both.
  body            TEXT,

  -- The read receipt. ONE nullable column rather than a chat_message_reads
  -- table, because a conversation has exactly two sides: the reader is always
  -- the one who did not send it, so there is nothing a second row could add.
  -- This is the column to revisit — and only this one — if group threads are
  -- ever added.
  read_at         TIMESTAMPTZ,

  -- "Time of message". The client's clock is never trusted for this.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Soft delete, matching project_documents and projects. "Delete for me" is not
  -- offered: with two participants it is indistinguishable from tampering with
  -- someone else's copy of the record.
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT chat_messages_body_not_blank
    CHECK (body IS NULL OR length(btrim(body)) > 0),

  -- A message cannot be read before it was sent. Guards the clock-skew bug where
  -- a client-supplied read timestamp is written verbatim.
  CONSTRAINT chat_messages_read_after_sent
    CHECK (read_at IS NULL OR read_at >= created_at)
);

-- The thread pane: one conversation, newest first, paginated. PARTIAL on
-- deleted_at because every read in this feature filters it, so removed messages
-- stay out of the index entirely rather than merely out of the result.
CREATE INDEX chat_messages_conversation_created_idx
  ON chat_messages(conversation_id, created_at DESC) WHERE deleted_at IS NULL;

-- The unread badge. Narrow and partial: it indexes only the rows the count is
-- about, so the badge is an index-only scan over a handful of entries instead of
-- a filter over the whole thread's history.
CREATE INDEX chat_messages_unread_idx
  ON chat_messages(conversation_id, sender_user_id)
  WHERE read_at IS NULL AND deleted_at IS NULL;

/* -------------------------------------------------------------------------- */
/* 4. chat_attachments — documents and images                                 */
/* -------------------------------------------------------------------------- */

-- Same shape and the same decisions as email_attachments and project_documents:
-- METADATA IN POSTGRES, BYTES IN THE BUCKET, joined by file_key. A bytea column
-- would put a 25 MB PDF behind every careless SELECT *, carry the whole archive
-- into each database backup, and sit in TOAST storage in front of the metadata
-- queries this feature actually runs.
--
-- The bucket is the PRIVATE documents bucket, not uploads/ — nothing serves it
-- statically. Download is an authorized endpoint that checks the caller is one
-- of the conversation's two sides (or an admin) and then streams the object.
-- Images are not special-cased: an inline <img> preview uses the same endpoint
-- via a short-lived signed URL, because a client's bank statement and a
-- screenshot of it are the same secret.
CREATE TABLE chat_attachments (
  id              SERIAL PRIMARY KEY,

  -- CASCADE: an attachment describes its message and means nothing without it.
  -- Note this fires only on a TRUE delete; the soft delete above leaves the rows
  -- and the bytes alone, so a mis-click stays recoverable.
  message_id      BIGINT       NOT NULL REFERENCES chat_messages(id) ON UPDATE CASCADE ON DELETE CASCADE,

  -- The generated storage key, e.g. "chat/17/9f3c…b1.pdf" — where 17 is the
  -- CONVERSATION, not this message. UNIQUE for the same reason
  -- project_documents.file_key is, with the extra job it has in
  -- email_attachments: the browser uploads before a message exists, so this
  -- index is what stops one uploaded object being attached to two messages by a
  -- replayed POST.
  file_key        VARCHAR(512) NOT NULL UNIQUE,

  -- The name the file arrived with, shown back to the user and used for the
  -- Content-Disposition filename on download. NEVER used to build a path: it is
  -- attacker-controlled, and "../../server.js" is an ordinary string here.
  original_name   VARCHAR(255) NOT NULL,

  -- Measured from the upload, never taken from the request, and constrained to
  -- an allowlist in the middleware.
  mime_type       VARCHAR(150) NOT NULL,

  -- BIGINT, as in 18 and 19: the cap is configuration, INTEGER tops out at 2 GB,
  -- and widening a column later is a migration on a large table. The CHECK is
  -- what actually means "there are bytes" — NOT NULL alone accepts a zero-byte
  -- file, which is a failed upload, not a document.
  size_bytes      BIGINT       NOT NULL CHECK (size_bytes > 0),

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- The only access path: "the attachments on this message", and the batched form
-- of it for a page of messages (WHERE message_id = ANY($1)). file_key needs no
-- index of its own — the UNIQUE constraint already built one.
CREATE INDEX chat_attachments_message_id_idx ON chat_attachments(message_id);

COMMIT;


/* ==========================================================================
 * READ QUERIES — the three the portal actually issues.
 * Kept here as documentation; they are not run by this migration.
 * ==========================================================================

-- ---------------------------------------------------------------------------
-- A. PORTAL SECTION ONE — the company's CUSTOMERS (owner + teammates), for the
--    signed-in accounting manager. The manager-must-be-assigned rule is in the
--    WHERE clause, not merely in the application: c.accounting_manager_user_id =
--    :managerUserId. A manager who is not on the company gets zero rows.
--
--    LEFT JOIN on the conversation because someone with no thread yet must still
--    appear in the list — that is how the first message ever gets sent.
-- ---------------------------------------------------------------------------
SELECT
  u.id                                        AS user_id,
  u.first_name, u.last_name, u.email, u.avatar_key,
  CASE WHEN u.id = c.owner_user_id THEN 'OWNER' ELSE 'TEAMMATE' END AS member_type,
  conv.id                                     AS conversation_id,
  conv.last_message_at,
  COALESCE(unread.n, 0)                       AS unread_count
FROM companies c
JOIN LATERAL (
  SELECT c.owner_user_id AS user_id
  UNION
  SELECT cm.user_id FROM company_members cm WHERE cm.company_id = c.id
) roster ON TRUE
JOIN users u ON u.id = roster.user_id
LEFT JOIN chat_conversations conv
       ON conv.company_id = c.id
      AND conv.accounting_manager_user_id = :managerUserId
      AND conv.participant_user_id = u.id
LEFT JOIN LATERAL (
  SELECT count(*) AS n
  FROM chat_messages m
  WHERE m.conversation_id = conv.id
    AND m.sender_user_id <> :managerUserId
    AND m.read_at IS NULL
    AND m.deleted_at IS NULL
) unread ON TRUE
WHERE c.id = :companyId
  AND c.deleted_at IS NULL
  AND c.accounting_manager_user_id = :managerUserId
ORDER BY conv.last_message_at DESC NULLS LAST, u.first_name;

-- ---------------------------------------------------------------------------
-- B. PORTAL SECTION TWO — the company's SPECIALISTS. Identical shape; only the
--    roster subquery changes. It unions the three standing service-line
--    specialists on `companies` with the ACTIVE rows in
--    company_specialist_assignments, because 06/14 made those two independent
--    facts: the columns say "who is the ONE tax/payroll/bookkeeping specialist
--    right now", the assignment table records specialist WORK.
-- ---------------------------------------------------------------------------
SELECT
  u.id AS user_id, u.first_name, u.last_name, u.email, u.avatar_key,
  conv.id AS conversation_id, conv.last_message_at,
  COALESCE(unread.n, 0) AS unread_count
FROM companies c
JOIN LATERAL (
  SELECT c.bookkeeping_specialist_user_id AS user_id
  UNION SELECT c.payroll_specialist_user_id
  UNION SELECT c.tax_specialist_user_id
  UNION SELECT a.specialist_user_id
          FROM company_specialist_assignments a
         WHERE a.company_id = c.id AND a.assignment_status = 'ACTIVE'
) roster ON roster.user_id IS NOT NULL
JOIN users u ON u.id = roster.user_id
LEFT JOIN chat_conversations conv
       ON conv.company_id = c.id
      AND conv.accounting_manager_user_id = :managerUserId
      AND conv.participant_user_id = u.id
LEFT JOIN LATERAL (
  SELECT count(*) AS n FROM chat_messages m
  WHERE m.conversation_id = conv.id AND m.sender_user_id <> :managerUserId
    AND m.read_at IS NULL AND m.deleted_at IS NULL
) unread ON TRUE
WHERE c.id = :companyId
  AND c.deleted_at IS NULL
  AND c.accounting_manager_user_id = :managerUserId
ORDER BY conv.last_message_at DESC NULLS LAST, u.first_name;

-- ---------------------------------------------------------------------------
-- C. THE THREAD — one page of messages with sender AND receiver, both with
--    their email addresses, plus the company, plus attachments. This is the
--    query that shows why neither the receiver nor any email address needs a
--    column: every one of them is a join away and none of them can go stale.
--
--    Keyset pagination on (created_at, id), not OFFSET: a live thread receives
--    messages while the user scrolls, and OFFSET would skip or repeat rows.
-- ---------------------------------------------------------------------------
SELECT
  m.id, m.body, m.created_at, m.read_at,
  conv.company_id,
  co.company_email,
  s.id    AS sender_user_id,   s.email AS sender_email,
  r.id    AS receiver_user_id, r.email AS receiver_email,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',           at.id,
        'originalName', at.original_name,
        'mimeType',     at.mime_type,
        'sizeBytes',    at.size_bytes
      ) ORDER BY at.id
    ) FILTER (WHERE at.id IS NOT NULL),
    '[]'::jsonb
  ) AS attachments
FROM chat_messages m
JOIN chat_conversations conv ON conv.id = m.conversation_id
JOIN companies co            ON co.id = conv.company_id
JOIN users s                 ON s.id = m.sender_user_id
-- The receiver: whichever side did not send it. See consequence 3 in the header.
JOIN users r ON r.id = CASE
                         WHEN m.sender_user_id = conv.accounting_manager_user_id
                           THEN conv.participant_user_id
                         ELSE conv.accounting_manager_user_id
                       END
LEFT JOIN chat_attachments at ON at.message_id = m.id
WHERE m.conversation_id = :conversationId
  AND m.deleted_at IS NULL
  AND (m.created_at, m.id) < (:beforeCreatedAt, :beforeId)   -- omit for page 1
GROUP BY m.id, conv.company_id, co.company_email, s.id, r.id
ORDER BY m.created_at DESC, m.id DESC
LIMIT 50;

-- Attachment DOWNLOAD is not a query — it is GET /chat/attachments/:id, which
-- resolves file_key through storage.js after checking the caller is one of the
-- conversation's two sides. The key itself is never returned to the client.
 * ========================================================================== */
