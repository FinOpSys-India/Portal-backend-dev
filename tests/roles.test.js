'use strict';

/**
 * Integration tests for GET /roles — the catalog the invite forms read their
 * roleId and specificRoleId from — through the real Express app with Prisma
 * mocked.
 *
 * The endpoint is small, so what these tests protect is not its logic but its
 * CONTRACT: POST /invitations takes numeric ids, this is the only place that
 * hands them out, and a frontend that stops receiving `specificRoleId` (or
 * receives it under another name) silently loses the ability to invite anyone
 * with a subdivided role.
 */

const mockPrisma = {
  user: { findUnique: jest.fn() },
  role: { findMany: jest.fn() },
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
};

jest.mock('../src/config/prisma', () => ({
  prisma: mockPrisma,
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));

const request = require('supertest');
const app = require('../src/app');
const { signAccessToken } = require('../src/utils/tokens');

const ADMIN_ID = 1;

function auth({ userId = ADMIN_ID, role = 'ADMIN', specificRole = null } = {}) {
  return `Bearer ${signAccessToken({ userId, email: 'u@finopsys.ai', role, specificRole })}`;
}

/** The seeded catalog, shaped as the Prisma select returns it. */
function catalog() {
  return [
    { id: 1, code: 'ADMIN', name: 'Administrator', specificRoles: [] },
    { id: 2, code: 'ACCOUNTING_MANAGER', name: 'Accounting Manager', specificRoles: [] },
    {
      id: 3,
      code: 'SPECIALIST',
      name: 'Specialist',
      specificRoles: [
        { id: 3, code: 'SPECIALIST_1', name: 'Payroll Specialist' },
        { id: 4, code: 'SPECIALIST_2', name: 'Tax Specialist' },
        { id: 5, code: 'SPECIALIST_3', name: 'Bookkeeping Specialist' },
        { id: 6, code: 'SPECIALIST_4', name: 'FP&A Specialist' },
      ],
    },
    {
      id: 4,
      code: 'CUSTOMER',
      name: 'Customer',
      specificRoles: [
        { id: 1, code: 'OWNER', name: 'Owner' },
        { id: 2, code: 'TEAM', name: 'Team' },
      ],
    },
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  // requireAuth re-reads the subject to check token freshness.
  mockPrisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE', passwordChangedAt: null });
  mockPrisma.role.findMany.mockResolvedValue(catalog());
});

describe('GET /roles', () => {
  it('returns every role with its id, code, and name', async () => {
    const res = await request(app).get('/api/roles').set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.roles).toHaveLength(4);
    expect(res.body.data.roles.map((r) => r.code)).toEqual([
      'ADMIN',
      'ACCOUNTING_MANAGER',
      'SPECIALIST',
      'CUSTOMER',
    ]);
    expect(res.body.data.roles[0]).toMatchObject({ roleId: 1, code: 'ADMIN', name: 'Administrator' });
  });

  it('exposes the numeric ids POST /invitations requires', async () => {
    const res = await request(app).get('/api/roles').set('Authorization', auth());

    const specialist = res.body.data.roles.find((r) => r.code === 'SPECIALIST');

    // This is the whole reason the endpoint exists: without these two numbers a
    // frontend has to hardcode ids that differ between environments.
    expect(specialist.roleId).toBe(3);
    expect(specialist.specificRoles).toEqual([
      { specificRoleId: 3, code: 'SPECIALIST_1', name: 'Payroll Specialist' },
      { specificRoleId: 4, code: 'SPECIALIST_2', name: 'Tax Specialist' },
      { specificRoleId: 5, code: 'SPECIALIST_3', name: 'Bookkeeping Specialist' },
      { specificRoleId: 6, code: 'SPECIALIST_4', name: 'FP&A Specialist' },
    ]);
  });

  it('flags which roles need the second dropdown', async () => {
    const res = await request(app).get('/api/roles').set('Authorization', auth());

    const by = Object.fromEntries(res.body.data.roles.map((r) => [r.code, r]));

    // The form reads this instead of keeping its own list of which roles have
    // subdivisions — a list that would drift from the seed.
    expect(by.SPECIALIST.requiresSpecificRole).toBe(true);
    expect(by.CUSTOMER.requiresSpecificRole).toBe(true);
    expect(by.ADMIN.requiresSpecificRole).toBe(false);
    expect(by.ACCOUNTING_MANAGER.requiresSpecificRole).toBe(false);
  });

  it('returns an empty list of subdivisions rather than omitting the key', async () => {
    const res = await request(app).get('/api/roles').set('Authorization', auth());

    const manager = res.body.data.roles.find((r) => r.code === 'ACCOUNTING_MANAGER');

    // `roles.specificRoles.map(...)` must not throw on a role that has none.
    expect(manager.specificRoles).toEqual([]);
  });

  it('carries the customer subdivisions the customer invite page needs', async () => {
    const res = await request(app).get('/api/roles').set('Authorization', auth());

    const customer = res.body.data.roles.find((r) => r.code === 'CUSTOMER');

    expect(customer.roleId).toBe(4);
    expect(customer.specificRoles.find((s) => s.code === 'OWNER')).toEqual({
      specificRoleId: 1,
      code: 'OWNER',
      name: 'Owner',
    });
  });

  it('orders roles and their subdivisions deterministically', async () => {
    await request(app).get('/api/roles').set('Authorization', auth());

    // A dropdown whose options reshuffle between page loads is a bug users
    // report as "the list keeps moving".
    expect(mockPrisma.role.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { id: 'asc' },
        select: expect.objectContaining({
          specificRoles: expect.objectContaining({ orderBy: { id: 'asc' } }),
        }),
      })
    );
  });

  it('is readable by any authenticated user, not just an admin', async () => {
    const manager = await request(app)
      .get('/api/roles')
      .set('Authorization', auth({ userId: 11, role: 'ACCOUNTING_MANAGER' }));
    const customer = await request(app)
      .get('/api/roles')
      .set('Authorization', auth({ userId: 10, role: 'CUSTOMER', specificRole: 'OWNER' }));

    // Reference data, and creating an invitation is gated where it matters. A
    // 403 here would only be a failure the invite form could do nothing about.
    expect(manager.status).toBe(200);
    expect(customer.status).toBe(200);
  });

  it('refuses an unauthenticated request', async () => {
    const res = await request(app).get('/api/roles');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
    expect(mockPrisma.role.findMany).not.toHaveBeenCalled();
  });

  it('rejects a query parameter rather than ignoring it', async () => {
    const res = await request(app).get('/api/roles?code=SPECIALIST').set('Authorization', auth());

    // The endpoint takes none. A silently ignored filter is the worst outcome:
    // the request succeeds and the caller believes it was applied.
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('code');
    expect(mockPrisma.role.findMany).not.toHaveBeenCalled();
  });

  it('survives an unseeded catalog with an empty list', async () => {
    mockPrisma.role.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/roles').set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.roles).toEqual([]);
  });

  it('reads no user columns beyond the catalog itself', async () => {
    const res = await request(app).get('/api/roles').set('Authorization', auth());

    // The role tables hold no personal data, and this endpoint must not start
    // joining any: it is the one directory readable by every authenticated user.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('email');
    expect(body).not.toContain('users');
  });
});
