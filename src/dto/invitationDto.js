'use strict';

/**
 * Response DTO for the invitation flows.
 *
 * The `token` column is never mapped here, at all. It is the invitation secret —
 * whoever holds it can complete the sign-up — so it exists in exactly two
 * places: the row, and the link in the invitee's email.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toInvitation(invitation) {
  return {
    id: invitation.id,
    email: invitation.email,
    firstName: invitation.firstName,
    lastName: invitation.lastName,
    roleId: invitation.roleId,
    roleCode: invitation.role?.code ?? null,
    roleName: invitation.role?.name ?? null,
    specificRoleId: invitation.specificRoleId ?? null,
    specificRoleCode: invitation.specificRole?.code ?? null,
    specificRoleName: invitation.specificRole?.name ?? null,
    invitedById: invitation.invitedById,
    invitedBy: invitation.invitedBy
      ? {
          userId: invitation.invitedBy.id,
          firstName: invitation.invitedBy.firstName,
          lastName: invitation.invitedBy.lastName,
          email: invitation.invitedBy.email,
        }
      : null,
    acceptedUserId: invitation.acceptedUserId ?? null,
    status: invitation.status,
    // Derived rather than left for the client to compute against its own clock,
    // which may be wrong or in another timezone.
    isExpired: invitation.expiresAt ? new Date(invitation.expiresAt) <= new Date() : false,
    expiresAt: iso(invitation.expiresAt),
    createdAt: iso(invitation.createdAt),
  };
}

function toInvitationList({ rows, total, limit, offset, sort, order }) {
  return {
    invitations: rows.map(toInvitation),
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      sort,
      order,
    },
  };
}

module.exports = { toInvitation, toInvitationList };
