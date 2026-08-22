-- 21_add_chat_realtime.sql
--
-- Makes the chat tables from 20_add_chat.sql push live updates to the browser.
--
-- WHY THIS IS SQL AND NOT CODE. This API runs on Vercel as serverless functions
-- with a 10-second ceiling per request (vercel.json), so it cannot hold a
-- WebSocket or an SSE stream open — the connection would be cut mid-conversation
-- every ten seconds. Supabase Realtime already holds those sockets, reading the
-- Postgres replication stream. The browser subscribes to it directly; this file
-- is what makes that both possible and safe.
--
-- THE SHAPE. Writes still go through the API and only through the API — the
-- browser never inserts a message. What the browser gets is a READ-ONLY feed of
-- rows it is already allowed to see:
--
--   API writes the message  ->  Postgres WAL  ->  Realtime  ->  the other side's
--   screen, with no refresh and no polling.
--
-- Safe to re-run: every statement is guarded.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 1. Publication — which tables Realtime is allowed to stream                */
/* -------------------------------------------------------------------------- */

-- REPLICA IDENTITY FULL puts the whole OLD row in the WAL on UPDATE and DELETE,
-- not just the primary key. Two things need it: the RLS check below, which must
-- evaluate the policy against the old row as well as the new one, and the read
-- receipt / soft delete, which are UPDATEs whose payload would otherwise arrive
-- as a bare id. It costs more WAL per update; on a chat table whose updates are
-- one timestamp each, that is nothing.
ALTER TABLE chat_conversations REPLICA IDENTITY FULL;
ALTER TABLE chat_messages      REPLICA IDENTITY FULL;

-- `supabase_realtime` is the publication Realtime reads. Adding a table twice is
-- an error, hence the guard — this is the one statement here that is not
-- naturally idempotent.
--
-- chat_attachments is deliberately NOT published. An attachment row arrives
-- microseconds after its message and would fire a second event for the same
-- screen update; the client reacts to the MESSAGE event and fetches the message
-- (attachments included) through the API, which is also where the signed
-- download URLs come from.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'chat_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
  END IF;

  -- Published for the list panes: last_message_at changing is what re-sorts the
  -- accounting manager's two sections without a refresh.
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'chat_conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_conversations;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 2. Row-level security — the browser may only see its own threads           */
/* -------------------------------------------------------------------------- */

-- Realtime evaluates these policies row by row, per subscriber, using the JWT
-- the browser connected with. Without them, `postgres_changes` on a published
-- table either delivers nothing or delivers everything — and "everything" here
-- is every client's chat.
--
-- THIS DOES NOT AFFECT THE API. Prisma connects as the table OWNER (postgres),
-- and an owner bypasses RLS unless FORCE ROW LEVEL SECURITY is set, which it is
-- not. Every backend query keeps working exactly as before. (If DATABASE_URL is
-- ever pointed at a non-owner role, that role needs BYPASSRLS or these policies
-- start applying to the API too — which would break it.)
ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_attachments   ENABLE ROW LEVEL SECURITY;

-- Which user is connected.
--
-- NOT auth.uid(). That reads the `sub` claim and casts it to UUID, and our users
-- are INTEGER rows in our own `users` table — this app signs its own JWTs and
-- does not use Supabase Auth. So the token minted by GET /chat/realtime-token
-- carries a custom `app_user_id` claim and the policies read that.
--
-- STABLE, not IMMUTABLE: the answer is fixed for one statement but different for
-- the next connection. SECURITY INVOKER (the default) is deliberate — this must
-- resolve the CALLER's token, never the definer's.
CREATE OR REPLACE FUNCTION public.chat_current_user_id()
RETURNS INTEGER
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'app_user_id', '')::INTEGER;
$$;

-- SELECT ONLY, and only for `authenticated`. There is no INSERT, UPDATE or
-- DELETE policy anywhere in this file, which means RLS denies all three by
-- default: a browser holding a realtime token cannot write a message, cannot
-- mark someone else's message read, and cannot delete anything. Every write
-- stays behind the API, where the company-scope check lives.
DROP POLICY IF EXISTS chat_conversations_select_own ON chat_conversations;
CREATE POLICY chat_conversations_select_own
  ON chat_conversations FOR SELECT TO authenticated
  USING (
    accounting_manager_user_id = public.chat_current_user_id()
    OR participant_user_id     = public.chat_current_user_id()
  );

-- The membership test goes through the conversation rather than being repeated
-- here, because the conversation is where the two sides are recorded. It is an
-- index lookup on the primary key, run once per delivered row.
DROP POLICY IF EXISTS chat_messages_select_own ON chat_messages;
CREATE POLICY chat_messages_select_own
  ON chat_messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM chat_conversations c
      WHERE c.id = chat_messages.conversation_id
        AND (
          c.accounting_manager_user_id = public.chat_current_user_id()
          OR c.participant_user_id     = public.chat_current_user_id()
        )
    )
  );

-- chat_attachments is not published to Realtime, so this policy is not for the
-- live feed — it is the safety net that keeps the table closed if it is ever
-- read with an anon or authenticated key by mistake. Note it exposes metadata
-- only: file_key is useless without a signed URL, which only the API issues.
DROP POLICY IF EXISTS chat_attachments_select_own ON chat_attachments;
CREATE POLICY chat_attachments_select_own
  ON chat_attachments FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM chat_messages m
      JOIN chat_conversations c ON c.id = m.conversation_id
      WHERE m.id = chat_attachments.message_id
        AND (
          c.accounting_manager_user_id = public.chat_current_user_id()
          OR c.participant_user_id     = public.chat_current_user_id()
        )
    )
  );

COMMIT;
