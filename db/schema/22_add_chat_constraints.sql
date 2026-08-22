-- 22_add_chat_constraints.sql
--
-- The three objects 20_add_chat.sql declares that the live database did not get.
--
-- WHY THEY ARE MISSING. The chat tables were created from a condensed version of
-- 20 — same columns, same keys, same indexes on the hot paths, but without the
-- manager-side index and without the two CHECK constraints on chat_messages.
-- This closes that gap so the deployed schema and db/schema/ describe the same
-- database, which is the only thing that makes this directory worth keeping.
--
-- NOTHING HERE FIXES A BUG. chatService already refuses a blank message
-- (validators/chatValidator.validateSendMessage, and again after the attachments
-- are measured) and never writes a read_at it did not generate. These are the
-- database's own guarantees for the same rules — the ones that hold when a row
-- is written by a migration, a console, or code that has not been written yet.
--
-- Safe to re-run: every statement is guarded.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 1. The manager's own inbox                                                 */
/* -------------------------------------------------------------------------- */

-- "Every thread this manager holds, most recent first" — their cross-company
-- inbox, and the reassignment audit.
--
-- Neither existing index answers it. The unique constraint leads with
-- company_id, so it can only be used for a question that names a company; the
-- participant index covers the other side of the thread. Without this, that
-- query is a sequential scan over every conversation in the system.
CREATE INDEX IF NOT EXISTS chat_conversations_manager_idx
  ON chat_conversations(accounting_manager_user_id, last_message_at DESC);

/* -------------------------------------------------------------------------- */
/* 2. What a message may be                                                   */
/* -------------------------------------------------------------------------- */

-- `body` is nullable because an attachment with no caption is an ordinary
-- message. A body of spaces is not: it is a client bug, and it renders as an
-- empty bubble nobody meant to send.
--
-- The complementary rule — "text OR at least one attachment" — is NOT here and
-- cannot be: it spans two tables, so it lives in chatService, inside the
-- transaction that writes both.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_body_not_blank') THEN
    ALTER TABLE chat_messages
      ADD CONSTRAINT chat_messages_body_not_blank
      CHECK (body IS NULL OR length(btrim(body)) > 0);
  END IF;
END $$;

-- A message cannot be read before it was sent. Guards the clock-skew bug where a
-- client-supplied read timestamp is written verbatim — the API generates
-- `read_at` itself today, and this is what keeps that true.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_read_after_sent') THEN
    ALTER TABLE chat_messages
      ADD CONSTRAINT chat_messages_read_after_sent
      CHECK (read_at IS NULL OR read_at >= created_at);
  END IF;
END $$;

COMMIT;
