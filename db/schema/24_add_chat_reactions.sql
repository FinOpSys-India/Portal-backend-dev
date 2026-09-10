-- 24_add_chat_reactions.sql
--
-- Emoji reactions on chat messages, and on individual files inside a message.
--
-- APPLIED BY HAND in the Supabase SQL editor — the enum, table, indexes, replica
-- identity, publication and RLS switch were run before this file existed. It
-- records what is live and adds the one piece that was missing: the SELECT
-- policy. RLS is on, so without a policy Realtime delivers no reaction events
-- to the browser at all. The API is unaffected either way (it connects as the
-- table owner — see 21_add_chat_realtime.sql).
--
-- Safe to re-run: every statement is guarded.
--
-- ============================================================================
-- THE MODEL
-- ============================================================================
--
--   ONE ROW = ONE PERSON'S REACTION ON ONE TARGET. The target is the message
--   when attachment_id is NULL, or one file on it when attachment_id is set.
--   message_id is filled in both cases, so a page of messages loads every
--   reaction — message and file alike — with one lookup on message_id.
--
--   ONE REACTION PER PERSON PER TARGET. Picking a different emoji replaces the
--   old one (INSERT ... ON CONFLICT ... DO UPDATE in chatRepository). It takes
--   two PARTIAL unique indexes rather than one UNIQUE (message_id,
--   attachment_id, user_id), because Postgres treats NULLs as distinct: that key
--   would let a person put any number of reactions on the same message.
--
--   user_id IS WHOEVER REACTED, taken from the verified token and never from the
--   request body. Only that person can change or remove it.
--
-- The emoji keys are the frontend's REACTIONS list, verbatim. Adding one later
-- is `ALTER TYPE chat_reaction_kind ADD VALUE '...'`; an enum value cannot be
-- removed in place, so add with care.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'chat_reaction_kind') THEN
    CREATE TYPE chat_reaction_kind AS ENUM ('like','laugh','sad','wow','love','thanks');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS chat_reactions (
  id            BIGSERIAL PRIMARY KEY,
  -- CASCADE on both targets: a reaction means nothing without what it is on.
  -- A soft-deleted message keeps its reactions, hidden with it.
  message_id    BIGINT  NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  attachment_id INTEGER REFERENCES chat_attachments(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  reaction      chat_reaction_kind NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One reaction per person on a message, and one per person on a file.
CREATE UNIQUE INDEX IF NOT EXISTS chat_reactions_message_id_user_id_idx
  ON chat_reactions(message_id, user_id) WHERE attachment_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chat_reactions_attachment_id_user_id_idx
  ON chat_reactions(attachment_id, user_id) WHERE attachment_id IS NOT NULL;

-- A page of messages: WHERE message_id = ANY($1). Neither unique index can
-- answer it, since each covers only half the rows.
CREATE INDEX IF NOT EXISTS chat_reactions_message_id_idx
  ON chat_reactions(message_id);

/* -------------------------------------------------------------------------- */
/* Realtime — same arrangement as 21_add_chat_realtime.sql                     */
/* -------------------------------------------------------------------------- */

-- FULL so a DELETE event carries the whole old row: the RLS check needs its
-- message_id, and the client needs to know which bubble to update.
ALTER TABLE chat_reactions REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'chat_reactions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_reactions;
  END IF;
END $$;

ALTER TABLE chat_reactions ENABLE ROW LEVEL SECURITY;

-- SELECT only, and only on threads the connected user is a side of — the same
-- rule as chat_messages_select_own. No INSERT/UPDATE/DELETE policy, so every
-- write stays behind the API.
DROP POLICY IF EXISTS chat_reactions_select_own ON chat_reactions;
CREATE POLICY chat_reactions_select_own
  ON chat_reactions FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM chat_messages m
      JOIN chat_conversations c ON c.id = m.conversation_id
      WHERE m.id = chat_reactions.message_id
        AND (
          c.accounting_manager_user_id = public.chat_current_user_id()
          OR c.participant_user_id     = public.chat_current_user_id()
        )
    )
  );

COMMIT;
