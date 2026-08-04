'use strict';

/**
 * Integration tests for the invitation endpoints.
 *
 * This module previously had NO test coverage at all — and was also the only
 * endpoint in the API with no authentication, taking an `invitedBy` user id
 * straight from the request body. The first describe block below is specifically
 * about that: the inviter must come from the verified token and must not be
 * expressible by the caller.
 */

const mockPrisma = {
  user: { findUnique: jest.fn(), findFirst: jest.fn() },
  role: { findUnique: jest.fn() },
  specificRole: { findUnique: jest.fn() },
  invitation: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
};

jest.mock('../src/config/prisma', () => ({
  prisma: mockPrisma,
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));

const mockSendInvitationEmail = jest.fn().mockResolvedValue({ messageId: 'test' });
jest.mock('../src/services/emailService', () => ({
  sendInvitationEmail: mockSendInvitationEmail,
  sendOtpEmail: jest.fn(),
  sendPasswordResetOtpEmail: jest.fn(),
  sendPasswordChangedEmail: jest.fn(),
  verifyEmailConnection: jest.fn(),
}));

const request = require('supertest');
const app = require('../src/app');
const { signAccessToken, hashInvitationToken } = require('../src/utils/tokens');

const URL = '/api/invitations';
const ADMIN_ID = 1;

function auth({ userId = ADMIN_ID, role = 'ADMIN', specificRole = null } = {}) {
  return `Bearer ${signAccessToken({ userId, email: 'admin@finopsys.ai', role, specificRole })}`;
}

function adminUser(overrides = {}) {
  return {
    id: ADMIN_ID,
    email: 'admin@finopsys.ai',
    firstName: 'Admin',
    lastName: 'User',
    status: 'ACTIVE',
    passwordChangedAt: null,
    role: { code: 'ADMIN' },
    specificRole: null,
    ...overrides,
  };
}

function roleRow(overrides = {}) {
  return { id: 4, code: 'CUSTOMER', name: 'Customer', specificRoles: [{ id: 1 }], ...overrides };
}

function invitationRow(overrides = {}) {
  return {
    id: 12,
    email: 'ada@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    roleId: 4,
    specificRoleId: 1,
    invitedById: ADMIN_ID,
    acceptedUserId: null,
    status: 'PENDING',
    tokenHash: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    createdAt: new Date('2026-08-01T00:00:00Z'),
    role: { code: 'CUSTOMER', name: 'Customer' },
    specificRole: { code: 'OWNER', name: 'Owner' },
    invitedBy: { id: ADMIN_ID, firstName: 'Admin', lastName: 'User', email: 'admin@finopsys.ai' },
    ...overrides,
  };
}

function validBody(overrides = {}) {
  return { email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace', roleId: 4, specificRoleId: 1, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
  mockPrisma.user.findUnique.mockResolvedValue(adminUser());
  mockPrisma.user.findFirst.mockResolvedValue(null);
  mockPrisma.role.findUnique.mockResolvedValue(roleRow());
  mockPrisma.specificRole.findUnique.mockResolvedValue({ id: 1, roleId: 4, code: 'OWNER', name: 'Owner' });
  mockPrisma.invitation.findFirst.mockResolvedValue(null);
  mockPrisma.invitation.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.invitation.create.mockResolvedValue(invitationRow());
  mockPrisma.invitation.update.mockResolvedValue(invitationRow({ status: 'SENT' }));
});

/* -------------------------------------------------------------------------- */
/* the security fix                                                           */
/* -------------------------------------------------------------------------- */

describe('POST /api/invitations — authentication', () => {
  it('refuses an unauthenticated request (401)', async () => {
    const res = await request(app).post(URL).send(validBody());

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
    expect(mockSendInvitationEmail).not.toHaveBeenCalled();
    expect(mockPrisma.invitation.create).not.toHaveBeenCalled();
  });

  it('refuses a non-admin caller (403)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      adminUser({ role: { code: 'CUSTOMER' }, specificRole: { code: 'OWNER' } })
    );

    const res = await request(app)
      .post(URL)
      .set('Authorization', auth({ role: 'CUSTOMER', specificRole: 'OWNER' }))
      .send(validBody());

    expect(res.status).toBe(403);
    expect(mockSendInvitationEmail).not.toHaveBeenCalled();
  });

  it('REJECTS an invitedBy in the body — the inviter is the token subject', async () => {
    /*
     * The original bug. With no auth and an `invitedBy` body field, anyone who
     * could reach the server could send mail from this system on behalf of any
     * active user: the invitee saw that person's name and reply-to address.
     * It is now an unknown field, so a client built against the old contract
     * fails loudly instead of appearing to work.
     */
    const res = await request(app)
      .post(URL)
      .set('Authorization', auth())
      .send({ ...validBody(), invitedBy: 999 });

    expect(res.status).toBe(400);
    expect(res.body.error.details.unknown).toContain('invitedBy');
    expect(mockPrisma.invitation.create).not.toHaveBeenCalled();
  });

  it('attributes the invitation to the authenticated caller', async () => {
    await request(app).post(URL).set('Authorization', auth()).send(validBody());

    expect(mockPrisma.invitation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ invitedById: ADMIN_ID }) })
    );
  });
});

/* -------------------------------------------------------------------------- */
/* creation                                                                   */
/* -------------------------------------------------------------------------- */

describe('POST /api/invitations — creation', () => {
  it('creates the invitation, emails the invitee, and marks it SENT', async () => {
    const res = await request(app).post(URL).set('Authorization', auth()).send(validBody());

    expect(res.status).toBe(201);
    expect(res.body.data.emailSent).toBe(true);
    expect(res.body.data.invitation.status).toBe('SENT');
    // The token is the invitation secret and must never be echoed.
    expect(JSON.stringify(res.body)).not.toContain('a'.repeat(64));

    const [mail] = mockSendInvitationEmail.mock.calls[0];
    expect(mail.invitationUrl).toMatch(/\/accept-invitation\?token=[0-9a-f]{64}$/);
  });

  it('still returns 201 when the email fails, but reports emailSent: false', async () => {
    mockSendInvitationEmail.mockRejectedValueOnce(new Error('SMTP down'));

    const res = await request(app).post(URL).set('Authorization', auth()).send(validBody());

    expect(res.status).toBe(201);
    // The status code alone does not tell you the invitee heard about it. The
    // row stays PENDING, which is exactly the marker for "never delivered".
    expect(res.body.data.emailSent).toBe(false);
    expect(res.body.data.invitation.status).toBe('PENDING');
    expect(mockPrisma.invitation.update).not.toHaveBeenCalled();
  });

  it('requires a specificRoleId for a subdivided role', async () => {
    const body = validBody();
    delete body.specificRoleId;

    const res = await request(app).post(URL).set('Authorization', auth()).send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/requires a specificRoleId/);
  });

  it('forbids a specificRoleId for a role with no subdivisions', async () => {
    mockPrisma.role.findUnique.mockResolvedValue(roleRow({ id: 1, code: 'ADMIN', specificRoles: [] }));

    const res = await request(app)
      .post(URL)
      .set('Authorization', auth())
      .send(validBody({ roleId: 1, specificRoleId: 1 }));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/has no subdivisions/);
  });

  it('rejects a specific role belonging to a different role', async () => {
    mockPrisma.specificRole.findUnique.mockResolvedValue({ id: 3, roleId: 3, code: 'SPECIALIST_1', name: 'Payroll' });

    const res = await request(app).post(URL).set('Authorization', auth()).send(validBody({ specificRoleId: 3 }));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/does not belong to role/);
  });

  it('refuses an address that already has an account (409)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: 77 });

    const res = await request(app).post(URL).set('Authorization', auth()).send(validBody());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('USER_ALREADY_EXISTS');
  });

  it('refuses a second email while a delivered invitation is still valid (409)', async () => {
    mockPrisma.invitation.findFirst.mockResolvedValue({ id: 5, expiresAt: new Date(Date.now() + 1000) });

    const res = await request(app).post(URL).set('Authorization', auth()).send(validBody());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVITATION_ALREADY_SENT');
    expect(res.body.error.details.invitationId).toBe(5);
  });

  it('normalises the email and accepts snake_case field names', async () => {
    await request(app)
      .post(URL)
      .set('Authorization', auth())
      // A client written against the old snake_case contract still works.
      .send({ email: '  Ada@Example.COM ', first_name: 'Ada', last_name: 'Lovelace', role_id: 4, specific_role_id: 1 });

    expect(mockPrisma.invitation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: 'ada@example.com' }) })
    );
  });

  it('refuses a body sending BOTH spellings of one field', async () => {
    const res = await request(app)
      .post(URL)
      .set('Authorization', auth())
      .send({ ...validBody(), first_name: 'Grace' });

    // Ambiguous input: one of the two was going to be discarded and the caller
    // could not learn which.
    expect(res.status).toBe(400);
    expect(res.body.error.details.conflictingFields).toContain('firstName');
  });
});

/* -------------------------------------------------------------------------- */
/* list / revoke / resend                                                     */
/* -------------------------------------------------------------------------- */

describe('GET /api/invitations', () => {
  it('returns a page scoped to the caller, with pagination', async () => {
    mockPrisma.invitation.findMany.mockResolvedValue([invitationRow()]);
    mockPrisma.invitation.count.mockResolvedValue(1);

    const res = await request(app).get(URL).set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.invitations[0]).toMatchObject({ id: 12, email: 'ada@example.com', roleCode: 'CUSTOMER' });
    expect(res.body.data.invitations[0].isExpired).toBe(false);
    expect(res.body.data.pagination).toMatchObject({ total: 1, limit: 25, offset: 0, hasMore: false });
    expect(JSON.stringify(res.body)).not.toContain('a'.repeat(64));
  });

  it('scopes a non-admin caller to their own invitations', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(adminUser({ role: { code: 'CUSTOMER' } }));
    mockPrisma.invitation.findMany.mockResolvedValue([]);
    mockPrisma.invitation.count.mockResolvedValue(0);

    await request(app).get(URL).set('Authorization', auth({ role: 'CUSTOMER' }));

    expect(mockPrisma.invitation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ invitedById: ADMIN_ID }) })
    );
  });

  it('rejects an unsupported sort field', async () => {
    const res = await request(app).get(`${URL}?sort=token`).set('Authorization', auth());
    expect(res.status).toBe(400);
    expect(res.body.error.fields.sort).toMatch(/Sort by one of/);
  });
});

describe('DELETE /api/invitations/:invitationId', () => {
  it('revokes a pending invitation, keeping the row', async () => {
    mockPrisma.invitation.findUnique.mockResolvedValue(invitationRow());
    mockPrisma.invitation.update.mockResolvedValue(invitationRow({ status: 'REVOKED' }));

    const res = await request(app).delete(`${URL}/12`).set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.invitation.status).toBe('REVOKED');
    // A state change, not a delete — the audit trail of who invited whom survives.
    expect(mockPrisma.invitation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'REVOKED' } })
    );
  });

  it('is idempotent on an already-revoked invitation', async () => {
    mockPrisma.invitation.findUnique.mockResolvedValue(invitationRow({ status: 'REVOKED' }));

    const res = await request(app).delete(`${URL}/12`).set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/already revoked/);
    expect(mockPrisma.invitation.update).not.toHaveBeenCalled();
  });

  it('refuses to revoke an accepted invitation (409)', async () => {
    mockPrisma.invitation.findUnique.mockResolvedValue(invitationRow({ status: 'ACCEPTED' }));

    const res = await request(app).delete(`${URL}/12`).set('Authorization', auth());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVITATION_ALREADY_ACCEPTED');
  });

  it("answers 404 — not 403 — for another user's invitation", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(adminUser({ role: { code: 'CUSTOMER' } }));
    mockPrisma.invitation.findUnique.mockResolvedValue(invitationRow({ invitedById: 999 }));

    const res = await request(app).delete(`${URL}/12`).set('Authorization', auth({ role: 'CUSTOMER' }));

    // Confirming that an invitation the caller may not touch nevertheless exists
    // would be an enumeration oracle.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('INVITATION_NOT_FOUND');
  });
});

describe('POST /api/invitations/:invitationId/resend', () => {
  it('mints a FRESH token, supersedes the old link, and extends the expiry', async () => {
    mockPrisma.invitation.findUnique.mockResolvedValue(invitationRow({ status: 'SENT' }));
    mockPrisma.invitation.update.mockResolvedValue(invitationRow({ status: 'SENT' }));

    const res = await request(app).post(`${URL}/12/resend`).set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.emailSent).toBe(true);

    /*
     * The server CANNOT re-send the original token: only its SHA-256 digest is
     * stored, so the raw value is genuinely unrecoverable. That is the point of
     * hashing it — keeping the raw token around so it could be re-sent is
     * precisely the weakness this replaced.
     *
     * Superseding on every resend is also the better behaviour on its own
     * merits, and matches password reset: a link that was emailed once may have
     * been forwarded or logged by a mail gateway, so bounding how long any one
     * copy stays usable is right. The invitee uses the newest email.
     */
    const [mail] = mockSendInvitationEmail.mock.calls[0];
    const emailedToken = mail.invitationUrl.split('token=')[1];
    expect(emailedToken).toMatch(/^[0-9a-f]{64}$/);
    expect(emailedToken).not.toBe('a'.repeat(64));

    // The row stores the DIGEST of the new token, never the token itself.
    const [args] = mockPrisma.invitation.update.mock.calls[0];
    expect(args.data.tokenHash).toBe(hashInvitationToken(emailedToken));
    expect(args.data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(args.data).not.toHaveProperty('token');
    expect(args.data.expiresAt).toEqual(expect.any(Date));

    // Back to PENDING until the mail actually goes out, so the status keeps
    // describing the CURRENT token rather than a previous delivery.
    expect(args.data.status).toBe('PENDING');
  });

  it('stores only the digest when creating an invitation', async () => {
    await request(app).post(URL).set('Authorization', auth()).send(validBody());

    const [args] = mockPrisma.invitation.create.mock.calls[0];
    const [mail] = mockSendInvitationEmail.mock.calls[0];
    const emailedToken = mail.invitationUrl.split('token=')[1];

    // The raw token reaches the invitee's inbox and nothing else.
    expect(args.data).not.toHaveProperty('token');
    expect(args.data.tokenHash).toBe(hashInvitationToken(emailedToken));
    expect(args.data.tokenHash).not.toBe(emailedToken);
  });

  it('refuses to resend a revoked invitation (409)', async () => {
    mockPrisma.invitation.findUnique.mockResolvedValue(invitationRow({ status: 'REVOKED' }));

    const res = await request(app).post(`${URL}/12/resend`).set('Authorization', auth());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVITATION_REVOKED');
  });
});
