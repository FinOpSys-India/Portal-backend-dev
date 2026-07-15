-- Database schema for the Finopsys Portal backend.
-- Derived from the queries in src/controllers/invitationController.js.
-- Safe to run multiple times (idempotent).

-- gen_random_uuid() lives in the pgcrypto extension.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Users who can send invitations. The invitation flow looks up the inviter
-- here (SELECT email, first_name, last_name FROM users WHERE id = $1).
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL UNIQUE,
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pending/accepted invitations. invited_by is intentionally NOT a foreign key:
-- the controller inserts the invitation first and tolerates a missing inviter,
-- so a hard FK would reject valid inserts.
CREATE TABLE IF NOT EXISTS invitations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT NOT NULL,
  first_name        TEXT NOT NULL,
  last_name         TEXT NOT NULL,
  role_id           UUID NOT NULL,
  specific_role_id  UUID,
  invited_by        UUID NOT NULL,
  token             TEXT NOT NULL UNIQUE,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The accept-invitation flow looks up rows by token.
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations (token);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations (email);
