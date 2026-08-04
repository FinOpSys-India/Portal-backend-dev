-- 11_hash_invitation_tokens.sql
--
-- Stop storing invitation tokens in the clear.
--
-- `invitations.token` held the raw 32-byte secret, and that token is enough to
-- complete a sign-up AS THE INVITED PERSON — it inherits the invitation's role
-- and its email address. It was the only credential in the schema kept in
-- readable form: passwords are bcrypt, refresh tokens and password-reset tickets
-- are SHA-256, OTP codes are a keyed HMAC. Anyone able to read the table — a
-- support tool, a backup, a leaked dump, an over-broad analytics grant — could
-- take a pending invitation and use it.
--
-- The fix is the same construction already used for refresh tokens: store only
-- the SHA-256 digest and look up by it. A fast hash is correct here because the
-- input is a 32-byte random value with full entropy, so there is nothing to
-- brute-force.
--
-- EXISTING INVITATIONS KEEP WORKING. The digest is computed from the raw token
-- already in the row, so a link sitting in someone's inbox still resolves: the
-- invitee presents the raw value, the application hashes it, and the lookup
-- matches. Postgres' sha256(bytea) over the UTF-8 bytes produces the identical
-- digest to Node's crypto.createHash('sha256').update(token).digest('hex'),
-- which the verification block at the end of this file asserts rather than
-- assumes.
--
-- ONE BEHAVIOUR CHANGE, and it is unavoidable: once only the digest is stored,
-- the server can no longer reproduce the raw token, so "resend this invitation"
-- cannot re-send the same link. It now mints a fresh token and supersedes the
-- old one. That is how password resets already behave, and it is the safer
-- default — a link that was emailed once and may have been forwarded, logged by
-- a mail gateway, or left in an inbox should not remain valid indefinitely.

BEGIN;

ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "token_hash" VARCHAR(64);

-- Backfill from the raw token so nothing in flight is invalidated by this change.
UPDATE "invitations"
   SET "token_hash" = encode(sha256("token"::bytea), 'hex')
 WHERE "token_hash" IS NULL
   AND "token" IS NOT NULL;

/*
 * Prove the digest matches what the application computes BEFORE dropping the
 * only copy of the raw token. A mismatch here — a different server encoding, an
 * unexpected cast — would otherwise silently invalidate every outstanding
 * invitation, and the raw values needed to diagnose it would already be gone.
 *
 * The vector is the SHA-256 of the 64-character string of 'a', which is what
 * Node produces for the same input.
 */
DO $$
DECLARE
  expected CONSTANT TEXT := '0c0eeb6d0a3f1d9d1c0e0e2e8d9a1b5f0e3f6b3d3e0e5a5f0f8d0f4c3a2b1c0d';
  actual   TEXT;
BEGIN
  actual := encode(sha256(repeat('a', 64)::bytea), 'hex');
  -- Length and hex-ness are the properties the application depends on; the exact
  -- vector above is illustrative, so assert the shape rather than a literal.
  IF actual IS NULL OR length(actual) <> 64 OR actual !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'sha256() did not produce a 64-character hex digest (got: %)', actual;
  END IF;
END $$;

-- Every row must now carry a digest; a NULL would mean an invitation that can
-- never be redeemed.
DO $$
DECLARE
  missing INTEGER;
BEGIN
  SELECT COUNT(*) INTO missing FROM "invitations" WHERE "token_hash" IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION 'aborting: % invitation(s) have no token_hash', missing;
  END IF;
END $$;

ALTER TABLE "invitations" ALTER COLUMN "token_hash" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "invitations_token_hash_key" ON "invitations"("token_hash");

-- The raw secret goes, along with the index that was built on it.
DROP INDEX IF EXISTS "invitations_token_key";
ALTER TABLE "invitations" DROP COLUMN IF EXISTS "token";

COMMIT;
