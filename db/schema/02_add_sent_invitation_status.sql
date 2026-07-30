-- AlterEnum
-- Invitations are created PENDING and promoted to SENT once the email is
-- delivered, so a stale PENDING row is the signal that the mail failed.
ALTER TYPE "invitation_status" ADD VALUE 'SENT' AFTER 'PENDING';
