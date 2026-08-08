'use strict';

/**
 * Integration tests for subscription management: reading the current
 * subscription, changing payroll head counts, cancelling, payment history, and
 * the Stripe billing portal.
 *
 * Prisma and Stripe are both mocked. NO TEST HERE CREATES A REAL CHARGE.
 */

const mockPrisma = {
  user: { findUnique: jest.fn() },
  company: { findFirst: jest.fn(), update: jest.fn() },
  servicePlan: { findMany: jest.fn() },
  companySubscription: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  companySubscriptionItem: { create: jest.fn(), update: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  companyPayment: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
  stripeEvent: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  idempotencyKey: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
};

const mockStripe = {
  prices: { retrieve: jest.fn() },
  customers: { create: jest.fn(), retrieve: jest.fn() },
  checkout: { sessions: { create: jest.fn(), retrieve: jest.fn(), listLineItems: jest.fn() } },
  subscriptions: { retrieve: jest.fn(), update: jest.fn(), cancel: jest.fn() },
  subscriptionItems: { create: jest.fn(), update: jest.fn(), del: jest.fn() },
  billingPortal: { sessions: { create: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
};

jest.mock('../src/config/prisma', () => ({
  prisma: mockPrisma,
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));

jest.mock('../src/config/stripe', () => ({
  getStripe: () => mockStripe,
  isConfigured: () => true,
  _resetStripe: jest.fn(),
}));

const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config');
const { signAccessToken } = require('../src/utils/tokens');

const USER_ID = 42;
const COMPANY_ID = 900;
const SUB_ID = 7001;

function auth({ userId = USER_ID, role = 'CUSTOMER', specificRole = 'OWNER' } = {}) {
  return `Bearer ${signAccessToken({ userId, email: 'owner@finopsys.ai', role, specificRole })}`;
}

function ownerUser(overrides = {}) {
  return {
    id: USER_ID,
    firstName: 'Ada',
    lastName: 'Lovelace',
    status: 'ACTIVE',
    role: { code: 'CUSTOMER' },
    specificRole: { code: 'OWNER' },
    ...overrides,
  };
}

function companyRow(overrides = {}) {
  return {
    id: COMPANY_ID,
    companyName: 'ABC Aerospace LLC',
    companyEmail: 'accounts@abcaerospace.com',
    ownerUserId: USER_ID,
    stripeCustomerId: 'cus_existing',
    deletedAt: null,
    ...overrides,
  };
}

const PLANS = {
  base: { id: 8, planCode: 'PAYROLL_BASE', planName: 'Payroll Base', stripeProductId: 'prod_pay', stripePriceId: 'price_pay_base' },
  employee: { id: 10, planCode: 'PAYROLL_W2_EMPLOYEE', planName: 'W-2 Employee Add-On', stripeProductId: 'prod_pay', stripePriceId: 'price_pay_employee' },
  contractor: { id: 9, planCode: 'PAYROLL_1099_CONTRACTOR', planName: '1099 Contractor Add-On', stripeProductId: 'prod_pay', stripePriceId: 'price_pay_contractor' },
  bookkeeping: { id: 2, planCode: 'BOOKKEEPING_GROWTH', planName: 'Bookkeeping Growth', stripeProductId: 'prod_book', stripePriceId: 'price_book_2' },
};

/** A live payroll + bookkeeping subscription: 12 employees, 4 contractors. */
function subscriptionRow(overrides = {}) {
  const {
    employeeQty = 12,
    contractorQty = 4,
    employeeItemId = 'si_emp',
    contractorItemId = 'si_con',
    includeBase = true,
    ...rest
  } = overrides;

  const items = [];
  if (includeBase) {
    items.push({ id: 20, companySubscriptionId: SUB_ID, servicePlanId: 8, quantity: 1, unitAmount: '29.00', currency: 'USD', stripeSubscriptionItemId: 'si_base', servicePlan: PLANS.base });
  }
  items.push(
    { id: 21, companySubscriptionId: SUB_ID, servicePlanId: 10, quantity: employeeQty, unitAmount: '15.00', currency: 'USD', stripeSubscriptionItemId: employeeItemId, servicePlan: PLANS.employee },
    { id: 22, companySubscriptionId: SUB_ID, servicePlanId: 9, quantity: contractorQty, unitAmount: '10.00', currency: 'USD', stripeSubscriptionItemId: contractorItemId, servicePlan: PLANS.contractor },
    { id: 23, companySubscriptionId: SUB_ID, servicePlanId: 2, quantity: 1, unitAmount: '249.00', currency: 'USD', stripeSubscriptionItemId: 'si_book', servicePlan: PLANS.bookkeeping }
  );

  return {
    id: SUB_ID,
    companyId: COMPANY_ID,
    status: 'ACTIVE',
    stripeSubscriptionId: 'sub_live_1',
    stripeCheckoutSessionId: 'cs_test_123',
    currentPeriodStart: new Date('2026-07-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    lastStripeEventAt: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    items,
    ...rest,
  };
}

/**
 * `findCurrentSubscriptionForCompany` issues findFirst twice (billable, then any
 * row). Staging one value for both keeps the tests reading straightforwardly.
 */
function stubSubscription(row) {
  mockPrisma.companySubscription.findFirst.mockResolvedValue(row);
}

beforeEach(() => {
  jest.clearAllMocks();
  config.billing.exposeStripeIds = true;

  mockPrisma.user.findUnique.mockResolvedValue(ownerUser());
  mockPrisma.company.findFirst.mockResolvedValue(companyRow());
  mockPrisma.companySubscription.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
  mockPrisma.companySubscriptionItem.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
  mockPrisma.companyPayment.findMany.mockResolvedValue([]);
  mockPrisma.companyPayment.count.mockResolvedValue(0);

  mockStripe.subscriptions.update.mockResolvedValue({
    id: 'sub_live_1',
    status: 'active',
    cancel_at_period_end: true,
    canceled_at: null,
  });
  mockStripe.subscriptions.cancel.mockResolvedValue({
    id: 'sub_live_1',
    status: 'canceled',
    cancel_at_period_end: false,
    canceled_at: 1_802_678_400,
  });
  mockStripe.subscriptionItems.update.mockResolvedValue({ id: 'si_emp' });
  mockStripe.subscriptionItems.create.mockResolvedValue({ id: 'si_new' });
  mockStripe.subscriptionItems.del.mockResolvedValue({ id: 'si_con', deleted: true });
  mockStripe.billingPortal.sessions.create.mockResolvedValue({
    url: 'https://billing.stripe.com/p/session/test_123',
  });

  stubSubscription(subscriptionRow());
});

/* -------------------------------------------------------------------------- */
/* GET /billing/subscription                                                   */
/* -------------------------------------------------------------------------- */

describe('GET /billing/subscription', () => {
  it('reports status, period, and the per-line breakdown', async () => {
    const res = await request(app)
      .get(`/api/billing/subscription?company_id=${COMPANY_ID}`)
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.hasSubscription).toBe(true);
    expect(res.body.data.subscription).toMatchObject({
      subscriptionId: SUB_ID,
      companyId: COMPANY_ID,
      status: 'ACTIVE',
      cancelAtPeriodEnd: false,
      currency: 'USD',
      currentPeriodEnd: '2026-08-01T00:00:00.000Z',
    });

    // 2900 + (12 x 1500) + (4 x 1000) + 24900 = 49800
    expect(res.body.data.subscription.recurringTotalAmountMinor).toBe(49800);
    expect(res.body.data.subscription.lines).toHaveLength(4);
  });

  it('prices lines from what was captured at purchase, not the live catalog', async () => {
    stubSubscription(
      subscriptionRow({
        items: [
          {
            id: 23,
            companySubscriptionId: SUB_ID,
            servicePlanId: 2,
            quantity: 1,
            // Bought at the old price; the catalog now says 249.
            unitAmount: '199.00',
            currency: 'USD',
            servicePlan: PLANS.bookkeeping,
          },
        ],
      })
    );

    const res = await request(app)
      .get(`/api/billing/subscription?company_id=${COMPANY_ID}`)
      .set('Authorization', auth());

    expect(res.body.data.subscription.lines[0].unitAmountMinor).toBe(19900);
    expect(res.body.data.subscription.recurringTotalAmountMinor).toBe(19900);
    expect(mockPrisma.servicePlan.findMany).not.toHaveBeenCalled();
  });

  it('omits a component whose count has dropped to zero', async () => {
    stubSubscription(subscriptionRow({ contractorQty: 0 }));

    const res = await request(app)
      .get(`/api/billing/subscription?company_id=${COMPANY_ID}`)
      .set('Authorization', auth());

    expect(res.body.data.subscription.lines.map((l) => l.optionId)).not.toContain(null);
    expect(res.body.data.subscription.lines).toHaveLength(3);
  });

  it('answers 200 with hasSubscription=false when the company has never subscribed', async () => {
    stubSubscription(null);

    const res = await request(app)
      .get(`/api/billing/subscription?company_id=${COMPANY_ID}`)
      .set('Authorization', auth());

    /*
     * Not a 404. Having no subscription is the normal state of every company
     * between onboarding and its first checkout — and the adjacent payments
     * endpoint already answered 200 with an empty list for exactly the same
     * situation, so the billing screen needed two different empty-state paths
     * for one condition.
     */
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.hasSubscription).toBe(false);
    expect(res.body.data.subscription).toBeNull();
  });

  it('requires company_id', async () => {
    const res = await request(app).get('/api/billing/subscription').set('Authorization', auth());
    expect(res.status).toBe(400);
  });

  it('denies a caller who does not own the company', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(companyRow({ ownerUserId: 7 }));

    const res = await request(app)
      .get(`/api/billing/subscription?company_id=${COMPANY_ID}`)
      .set('Authorization', auth());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COMPANY_ACCESS_DENIED');
  });

  it('requires authentication', async () => {
    const res = await request(app).get(`/api/billing/subscription?company_id=${COMPANY_ID}`);
    expect(res.status).toBe(401);
  });
});

/* -------------------------------------------------------------------------- */
/* PATCH /billing/subscription/payroll                                         */
/* -------------------------------------------------------------------------- */

describe('PATCH /billing/subscription/payroll', () => {
  function patch(body) {
    return request(app)
      .patch('/api/billing/subscription/payroll')
      .set('Authorization', auth())
      .send({ company_id: COMPANY_ID, ...body });
  }

  it('updates the quantity of an existing line', async () => {
    const res = await patch({ employee_count: 20 });

    expect(res.status).toBe(200);
    expect(mockStripe.subscriptionItems.update).toHaveBeenCalledWith('si_emp', {
      quantity: 20,
      proration_behavior: config.billing.prorationBehavior,
    });
    expect(mockPrisma.companySubscriptionItem.update).toHaveBeenCalledWith({
      where: { id: 21 },
      data: { quantity: 20 },
    });
    expect(res.body.data.changes).toEqual([{ component: 'employees', from: 12, to: 20 }]);
  });

  it('DELETES the Stripe line when a count drops to zero', async () => {
    const res = await patch({ contractor_count: 0 });

    expect(res.status).toBe(200);
    expect(mockStripe.subscriptionItems.del).toHaveBeenCalledWith('si_con', {
      proration_behavior: config.billing.prorationBehavior,
    });
    // Local row kept at zero with the dead Stripe id cleared, so the line can
    // come back later without colliding on the unique index.
    expect(mockPrisma.companySubscriptionItem.update).toHaveBeenCalledWith({
      where: { id: 22 },
      data: { quantity: 0, stripeSubscriptionItemId: null },
    });
  });

  it('CREATES a Stripe line when a count rises from zero', async () => {
    stubSubscription(subscriptionRow({ contractorQty: 0, contractorItemId: null }));

    const res = await patch({ contractor_count: 6 });

    expect(res.status).toBe(200);
    expect(mockStripe.subscriptionItems.create).toHaveBeenCalledWith({
      subscription: 'sub_live_1',
      price: 'price_pay_contractor',
      quantity: 6,
      proration_behavior: config.billing.prorationBehavior,
    });
    expect(mockPrisma.companySubscriptionItem.update).toHaveBeenCalledWith({
      where: { id: 22 },
      data: { quantity: 6, stripeSubscriptionItemId: 'si_new' },
    });
  });

  it('changes both counts in one call', async () => {
    const res = await patch({ employee_count: 15, contractor_count: 2 });

    expect(res.status).toBe(200);
    expect(res.body.data.changes).toEqual([
      { component: 'employees', from: 12, to: 15 },
      { component: 'contractors', from: 4, to: 2 },
    ]);
  });

  it('is a no-op when the counts already match', async () => {
    const res = await patch({ employee_count: 12, contractor_count: 4 });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/No change/);
    expect(mockStripe.subscriptionItems.update).not.toHaveBeenCalled();
  });

  it('resolves the price from our catalog, never from the request', async () => {
    stubSubscription(subscriptionRow({ contractorQty: 0, contractorItemId: null }));

    const res = await request(app)
      .patch('/api/billing/subscription/payroll')
      .set('Authorization', auth())
      .send({ company_id: COMPANY_ID, contractor_count: 3, price_id: 'price_one_cent' });

    expect(res.status).toBe(400);
    // Reported under the canonical camelCase name. The request said `price_id`;
    // normalizeRequest reconciles the two spellings before validation, so the
    // error names one field rather than depending on how the caller spelled it.
    expect(res.body.error.details.unknown).toContain('priceId');
    expect(mockStripe.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it.each([
    ['negative', { employee_count: -1 }, 'INVALID_EMPLOYEE_COUNT'],
    ['decimal', { employee_count: 2.5 }, 'INVALID_EMPLOYEE_COUNT'],
    ['non-numeric', { contractor_count: 'five' }, 'INVALID_CONTRACTOR_COUNT'],
    ['over the ceiling', { contractor_count: 10_000_000 }, 'INVALID_CONTRACTOR_COUNT'],
  ])('rejects a %s count', async (_label, body, code) => {
    const res = await patch(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(mockStripe.subscriptionItems.update).not.toHaveBeenCalled();
  });

  it('rejects a patch that changes nothing', async () => {
    const res = await patch({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses when the company is not subscribed to payroll', async () => {
    stubSubscription(
      subscriptionRow({
        includeBase: false,
        items: [
          { id: 23, companySubscriptionId: SUB_ID, servicePlanId: 2, quantity: 1, unitAmount: '249.00', currency: 'USD', servicePlan: PLANS.bookkeeping },
        ],
      })
    );

    const res = await patch({ employee_count: 5 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYROLL_NOT_SUBSCRIBED');
  });

  it('refuses on a cancelled subscription', async () => {
    stubSubscription(subscriptionRow({ status: 'CANCELED' }));

    const res = await patch({ employee_count: 5 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SUBSCRIPTION_NOT_ACTIVE');
  });

  it('refuses when the subscription is not linked to Stripe yet', async () => {
    stubSubscription(subscriptionRow({ stripeSubscriptionId: null }));

    const res = await patch({ employee_count: 5 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SUBSCRIPTION_NOT_ACTIVE');
  });

  it('does not write locally when the Stripe call fails', async () => {
    mockStripe.subscriptionItems.update.mockRejectedValue(new Error('Stripe is down'));

    const res = await patch({ employee_count: 20 });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('SUBSCRIPTION_UPDATE_FAILED');
    expect(mockPrisma.companySubscriptionItem.update).not.toHaveBeenCalled();
  });

  it('reports which components applied before a partial failure', async () => {
    mockStripe.subscriptionItems.update
      .mockResolvedValueOnce({ id: 'si_emp' })
      .mockRejectedValueOnce(new Error('Stripe is down'));

    const res = await patch({ employee_count: 20, contractor_count: 9 });

    expect(res.status).toBe(502);
    expect(res.body.error.details.applied).toEqual(['employees']);
    // The employee change really did happen in Stripe, so it is stored.
    expect(mockPrisma.companySubscriptionItem.update).toHaveBeenCalledWith({
      where: { id: 21 },
      data: { quantity: 20 },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* DELETE /billing/subscription                                                */
/* -------------------------------------------------------------------------- */

describe('DELETE /billing/subscription', () => {
  function cancel(body = {}) {
    return request(app)
      .delete('/api/billing/subscription')
      .set('Authorization', auth())
      .send({ company_id: COMPANY_ID, ...body });
  }

  it('defaults to cancelling at the end of the paid period', async () => {
    const res = await cancel();

    expect(res.status).toBe(200);
    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith('sub_live_1', {
      cancel_at_period_end: true,
    });
    expect(mockStripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(res.body.message).toMatch(/end of the current period/);
  });

  it('cancels immediately only when asked explicitly', async () => {
    const res = await cancel({ at_period_end: false });

    expect(res.status).toBe(200);
    expect(mockStripe.subscriptions.cancel).toHaveBeenCalledWith('sub_live_1');
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
    expect(mockPrisma.companySubscription.update).toHaveBeenCalledWith({
      where: { id: SUB_ID },
      data: expect.objectContaining({ status: 'CANCELED' }),
    });
  });

  it('mirrors what Stripe returned, not what was requested', async () => {
    mockStripe.subscriptions.update.mockResolvedValue({
      id: 'sub_live_1',
      status: 'active',
      cancel_at_period_end: true,
      canceled_at: 1_802_678_400,
    });

    await cancel();

    expect(mockPrisma.companySubscription.update).toHaveBeenCalledWith({
      where: { id: SUB_ID },
      data: { cancelAtPeriodEnd: true, canceledAt: new Date(1_802_678_400 * 1000) },
    });
  });

  it('is idempotent when cancellation is already scheduled', async () => {
    stubSubscription(subscriptionRow({ cancelAtPeriodEnd: true }));

    const res = await cancel();

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/already scheduled/);
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('404s when there is nothing to cancel', async () => {
    stubSubscription(null);

    const res = await cancel();

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SUBSCRIPTION_NOT_FOUND');
  });

  it('surfaces a Stripe failure without changing local state', async () => {
    mockStripe.subscriptions.update.mockRejectedValue(new Error('Stripe is down'));

    const res = await cancel();

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('SUBSCRIPTION_CANCEL_FAILED');
    expect(mockPrisma.companySubscription.update).not.toHaveBeenCalled();
  });

  it('rejects an unknown field in the body', async () => {
    const res = await cancel({ refund: true });

    expect(res.status).toBe(400);
    expect(res.body.error.details.unknown).toContain('refund');
  });

  it('denies a caller who does not own the company', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(companyRow({ ownerUserId: 7 }));

    const res = await cancel();

    expect(res.status).toBe(403);
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* GET /billing/payments                                                       */
/* -------------------------------------------------------------------------- */

describe('GET /billing/payments', () => {
  const PAYMENTS = [
    {
      id: 3,
      amountPaid: '498.00',
      currency: 'USD',
      status: 'PAID',
      paidAt: new Date('2026-07-01T00:00:00Z'),
      createdAt: new Date('2026-07-01T00:00:00Z'),
      failureReason: null,
      stripeInvoiceId: 'in_3',
      stripePaymentIntentId: 'pi_3',
    },
    {
      id: 2,
      amountPaid: '0.00',
      currency: 'USD',
      status: 'FAILED',
      paidAt: null,
      createdAt: new Date('2026-06-01T00:00:00Z'),
      failureReason: 'card_declined',
      stripeInvoiceId: 'in_2',
      stripePaymentIntentId: null,
    },
  ];

  it('returns receipts newest first, in minor units', async () => {
    mockPrisma.companyPayment.findMany.mockResolvedValue(PAYMENTS);
    mockPrisma.companyPayment.count.mockResolvedValue(2);

    const res = await request(app)
      .get(`/api/billing/payments?company_id=${COMPANY_ID}`)
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.payments[0]).toMatchObject({
      paymentId: 3,
      // The unit is now part of the field name. A bare `amount_paid: 49800` is
      // exactly the shape of value that gets rendered as "$49,800".
      amountPaidMinor: 49800,
      amountRefundedMinor: 0,
      currency: 'USD',
      status: 'PAID',
      paidAt: '2026-07-01T00:00:00.000Z',
    });
    expect(res.body.data.payments[1]).toMatchObject({ status: 'FAILED', failureReason: 'card_declined' });
    expect(res.body.data.pagination).toEqual({
      total: 2,
      limit: 25,
      offset: 0,
      hasMore: false,
      sort: 'paidAt',
      order: 'desc',
    });
  });

  it('paginates and reports hasMore', async () => {
    mockPrisma.companyPayment.findMany.mockResolvedValue([PAYMENTS[0]]);
    mockPrisma.companyPayment.count.mockResolvedValue(10);

    const res = await request(app)
      .get(`/api/billing/payments?company_id=${COMPANY_ID}&limit=1&offset=0`)
      .set('Authorization', auth());

    expect(mockPrisma.companyPayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1, skip: 0 })
    );
    expect(res.body.data.pagination).toEqual({
      total: 10,
      limit: 1,
      offset: 0,
      hasMore: true,
      sort: 'paidAt',
      order: 'desc',
    });
  });

  it('sorts by an allowlisted column and rejects anything else', async () => {
    mockPrisma.companyPayment.findMany.mockResolvedValue(PAYMENTS);
    mockPrisma.companyPayment.count.mockResolvedValue(2);

    await request(app)
      .get(`/api/billing/payments?company_id=${COMPANY_ID}&sort=amountPaid&order=asc`)
      .set('Authorization', auth());

    expect(mockPrisma.companyPayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ amountPaid: 'asc' }, { createdAt: 'desc' }] })
    );

    // The sort key is an allowlist, never a raw value forwarded to ORDER BY.
    const bad = await request(app)
      .get(`/api/billing/payments?company_id=${COMPANY_ID}&sort=passwordHash`)
      .set('Authorization', auth());

    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.sort).toMatch(/Sort by one of/);
  });

  it('clamps an oversized page request', async () => {
    await request(app)
      .get(`/api/billing/payments?company_id=${COMPANY_ID}&limit=100000`)
      .set('Authorization', auth());

    expect(mockPrisma.companyPayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: config.billing.maxPageSize })
    );
  });

  it('rejects a non-numeric limit', async () => {
    const res = await request(app)
      .get(`/api/billing/payments?company_id=${COMPANY_ID}&limit=all`)
      .set('Authorization', auth());

    expect(res.status).toBe(400);
  });

  it('returns an empty page rather than 404 when there is no history', async () => {
    const res = await request(app)
      .get(`/api/billing/payments?company_id=${COMPANY_ID}`)
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.payments).toEqual([]);
  });

  it('denies a caller who does not own the company', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(companyRow({ ownerUserId: 7 }));

    const res = await request(app)
      .get(`/api/billing/payments?company_id=${COMPANY_ID}`)
      .set('Authorization', auth());

    expect(res.status).toBe(403);
    expect(mockPrisma.companyPayment.findMany).not.toHaveBeenCalled();
  });

  it('hides Stripe ids when configured to', async () => {
    config.billing.exposeStripeIds = false;
    mockPrisma.companyPayment.findMany.mockResolvedValue(PAYMENTS);
    mockPrisma.companyPayment.count.mockResolvedValue(2);

    const res = await request(app)
      .get(`/api/billing/payments?company_id=${COMPANY_ID}`)
      .set('Authorization', auth());

    // Stripe ids are grouped under one `stripe` key that is present in full or
    // absent in full, rather than sprinkled as siblings that vanish one by one.
    expect(res.body.data.payments[0]).not.toHaveProperty('stripe');
    expect(res.body.data.payments[0].amountPaidMinor).toBe(49800);
  });
});

/* -------------------------------------------------------------------------- */
/* POST /billing/portal                                                        */
/* -------------------------------------------------------------------------- */

describe('POST /billing/portal', () => {
  function portal(body = {}) {
    return request(app)
      .post('/api/billing/portal')
      .set('Authorization', auth())
      .send({ company_id: COMPANY_ID, ...body });
  }

  it('mints a portal link for the company customer', async () => {
    const res = await portal();

    expect(res.status).toBe(201);
    expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_existing',
      return_url: config.billing.portalReturnUrl,
    });
    expect(res.body.data.portalUrl).toBe('https://billing.stripe.com/p/session/test_123');
    expect(res.body.data.companyId).toBe(COMPANY_ID);
    // This endpoint was the last one still answering in snake_case; every
    // response in the API is camelCase.
    expect(res.body.data).not.toHaveProperty('portal_url');
  });

  it('refuses when the company has no Stripe customer yet', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(companyRow({ stripeCustomerId: null }));

    const res = await portal();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SUBSCRIPTION_NOT_FOUND');
    expect(mockStripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('never lets the caller choose the customer', async () => {
    const res = await portal({ customer: 'cus_somebody_else' });

    expect(res.status).toBe(400);
    expect(res.body.error.details.unknown).toContain('customer');
  });

  it('surfaces a Stripe failure safely', async () => {
    mockStripe.billingPortal.sessions.create.mockRejectedValue(new Error('sk_live_xxx invalid'));

    const res = await portal();

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PORTAL_SESSION_FAILED');
    expect(JSON.stringify(res.body)).not.toContain('sk_live');
  });

  it('denies a caller who does not own the company', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(companyRow({ ownerUserId: 7 }));

    const res = await portal();

    expect(res.status).toBe(403);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/billing/portal').send({ company_id: COMPANY_ID });
    expect(res.status).toBe(401);
  });
});
