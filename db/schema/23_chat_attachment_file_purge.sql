-- 23_chat_attachment_file_purge.sql
--
-- Deleting a message now DESTROYS ITS FILES. The metadata row survives.
--
-- WHAT CHANGED AND WHY. Until now a soft delete hid the message and left the
-- attachments untouched — rows in Postgres, bytes in the documents bucket. The
-- bytes are the part that actually matters: a client's bank statement sent to
-- the wrong thread stayed in storage indefinitely, reachable by anyone who
-- could later read the object out of the bucket. "Deleted" has to mean the file
-- is gone.
--
-- WHAT SURVIVES. Everything in chat_attachments except the pointer: the id, the
-- original name, the MIME type, the size and the created_at. That is the record
-- of "a 2.3 MB PDF called statement.pdf was sent here and later removed", which
-- is what an audit needs and what a UI needs to render a tombstone in the
-- thread. Only file_key goes, because it names an object that no longer exists.
--
-- SO file_key BECOMES NULLABLE, and NULL is the marker: a row with a file_key
-- has bytes behind it, a row without one does not. No second column and no
-- second timestamp — when the file went is when the message went, and
-- chat_messages.deleted_at already records that.
--
-- THE UNIQUE INDEX IS KEPT AS IS. In Postgres a UNIQUE constraint permits any
-- number of NULLs, so purged rows do not collide with each other, while the
-- guarantee that one stored object cannot become two attachments still holds
-- for every row that still points at one.
--
-- THIS IS THE ONE IRREVERSIBLE PART OF A CHAT DELETE. The message row, its
-- body and the attachment metadata can all be brought back by clearing
-- deleted_at. The bytes cannot. That is the intent, not an oversight.
--
-- Safe to re-run.

BEGIN;

ALTER TABLE chat_attachments ALTER COLUMN file_key DROP NOT NULL;

COMMENT ON COLUMN chat_attachments.file_key IS
  'Storage key in the private documents bucket, or NULL once the object has '
  'been purged by a message delete. The rest of the row is retained as the '
  'record of what was sent.';

COMMIT;
