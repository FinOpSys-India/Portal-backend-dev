'use strict';

/**
 * Integration tests for the Stripe webhook and the checkout-status endpoint,
 * driven through the real Express app with Prisma and Stripe mocked.
 *
 * NO TEST HERE CREATES A REAL CHARGE, and no signature is ever really verified:
 * `webhooks.constructEvent` is a jest.fn() that either returns a staged event or
 * throws, which is exactly the two outcomes the handler has to distinguish.
 */

const mockPrisma = {
  user: { findUnique: jest.fn() },
  company: { findFirst: jest.fn(), update: jest.fn() },
  servicePlan: { findMany: jest.fn() },
  companySubscription: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  companySubscriptionItem: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  companyPayment: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  stripeEvent: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  idempotencyKey: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
};

const mockStripe = {
  prices: { retrieve: jest.fn() },
  customers: { create: jest.fn(), retrieve: jest.fn() },
  checkout: { sessions: { create: jest.fn(), retrieve: jest.fn(), listLineItems: jest.fn() } },
  subscriptions: { retrieve: jest.fn() },
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
const SESSION_ID = 'cs_test_123';

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

const BOOKKEEPING_PLAN = {
  id: 2,
  planCode: 'BOOKKEEPING_GROWTH',
  planName: 'Bookkeeping Growth',
  stripeProductId: 'prod_book',
  stripePriceId: 'price_book_2',
  amount: '249.00',
  currency: 'USD',
  billingInterval: 'MONTH',
  isActive: true,
};

const EMPLOYEE_PLAN = {
  id: 10,
  planCode: 'PAYROLL_W2_EMPLOYEE',
  planName: 'W-2 Employee Add-On',
  stripeProductId: 'prod_pay',
  stripePriceId: 'price_pay_employee',
  amount: '15.00',
  currency: 'USD',
  billingInterval: 'MONTH',
  isActive: true,
};

/** Our local subscription row, as the repository returns it (items included). */
function subscriptionRow(overrides = {}) {
  return {
    id: SUB_ID,
    companyId: COMPANY_ID,
    status: 'INCOMPLETE',
    stripeSubscriptionId: null,
    stripeCheckoutSessionId: SESSION_ID,
    currentPeriodEnd: null,
    lastStripeEventAt: null,
    items: [
      { id: 11, companySubscriptionId: SUB_ID, servicePlanId: 2, quantity: 1, servicePlan: BOOKKEEPING_PLAN },
      { id: 12, companySubscriptionId: SUB_ID, servicePlanId: 10, quantity: 12, servicePlan: EMPLOYEE_PLAN },
    ],
    ...overrides,
  };
}

/** Stripe stamps `created` in Unix seconds; the ordering guard compares on it. */
const EVENT_AT = 1_800_000_500;

function checkoutCompletedEvent(overrides = {}) {
  return {
    id: 'evt_1',
    created: EVENT_AT,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: SESSION_ID,
        object: 'checkout.session',
        mode: 'subscription',
        status: 'complete',
        payment_status: 'paid',
        customer: 'cus_existing',
        subscription: 'sub_live_1',
        metadata: { company_id: String(COMPANY_ID), user_id: String(USER_ID) },
        ...overrides,
      },
    },
  };
}

/** POST a webhook body. The route parses it raw, so the payload is sent as text. */
function postWebhook(event, { signature = 't=1,v1=deadbeef' } = {}) {
  const req = request(app)
    .post('/api/billing/webhook')
    .set('Content-Type', 'application/json');
  if (signature !== null) req.set('Stripe-Signature', signature);
  return req.send(JSON.stringify(event));
}

beforeEach(() => {
  jest.clearAllMocks();
  config.stripe.webhookSecret = 'whsec_test';

  mockPrisma.user.findUnique.mockResolvedValue(ownerUser());
  mockPrisma.company.findFirst.mockResolvedValue(companyRow());
  mockPrisma.company.update.mockImplementation(async ({ data }) => companyRow(data));
  mockPrisma.companySubscription.findUnique.mockResolvedValue(subscriptionRow());
  mockPrisma.companySubscription.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
  mockPrisma.companySubscriptionItem.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
  mockPrisma.companyPayment.findUnique.mockResolvedValue(null);
  mockPrisma.companyPayment.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
  mockPrisma.stripeEvent.findUnique.mockResolvedValue(null);
  mockPrisma.stripeEvent.create.mockImplementation(async ({ data }) => ({ id: 1, processedAt: null, ...data }));
  mockPrisma.stripeEvent.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
  mockPrisma.servicePlan.findMany.mockResolvedValue([BOOKKEEPING_PLAN, EMPLOYEE_PLAN]);

  mockStripe.checkout.sessions.listLineItems.mockResolvedValue({
    data: [
      { id: 'li_1', quantity: 1, price: { id: 'price_book_2', product: 'prod_book' } },
      { id: 'li_2', quantity: 12, price: { id: 'price_pay_employee', product: 'prod_pay' } },
    ],
  });
  mockStripe.subscriptions.retrieve.mockResolvedValue({
    id: 'sub_live_1',
    status: 'active',
    cancel_at_period_end: false,
    canceled_at: null,
    current_period_start: 1_800_000_000,
    current_period_end: 1_802_678_400,
    items: {
      data: [
        { id: 'si_1', price: { id: 'price_book_2' } },
        { id: 'si_2', price: { id: 'price_pay_employee' } },
      ],
    },
  });
});

/* -------------------------------------------------------------------------- */
/* signature verification                                                      */
/* -------------------------------------------------------------------------- */

describe('signature verification', () => {
  it('processes an event whose signature verifies', async () => {
    const event = checkoutCompletedEvent();
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    const res = await postWebhook(event);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, duplicate: false });
  });

  it('receives the RAW request body, not a re-serialised object', async () => {
    const event = checkoutCompletedEvent();
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    const [rawBody, signature, secret] = mockStripe.webhooks.constructEvent.mock.calls[0];
    expect(Buffer.isBuffer(rawBody)).toBe(true);
    expect(rawBody.toString('utf8')).toBe(JSON.stringify(event));
    expect(signature).toBe('t=1,v1=deadbeef');
    expect(secret).toBe('whsec_test');
  });

  it('rejects an invalid signature and writes nothing', async () => {
    mockStripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload');
    });

    const res = await postWebhook(checkoutCompletedEvent());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(mockPrisma.companySubscription.update).not.toHaveBeenCalled();
    expect(mockPrisma.stripeEvent.create).not.toHaveBeenCalled();
  });

  it('rejects a request with no Stripe-Signature header', async () => {
    const res = await postWebhook(checkoutCompletedEvent(), { signature: null });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(mockStripe.webhooks.constructEvent).not.toHaveBeenCalled();
  });

  it('requires no authentication — Stripe holds no access token', async () => {
    const event = checkoutCompletedEvent();
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    const res = await postWebhook(event);

    expect(res.status).not.toBe(401);
  });
});

/* -------------------------------------------------------------------------- */
/* idempotency                                                                 */
/* -------------------------------------------------------------------------- */

describe('idempotency', () => {
  it('drops a redelivery of an already-processed event', async () => {
    const event = checkoutCompletedEvent();
    mockStripe.webhooks.constructEvent.mockReturnValue(event);
    mockPrisma.stripeEvent.findUnique.mockResolvedValue({
      id: 1,
      stripeEventId: 'evt_1',
      processedAt: new Date('2026-07-01T00:00:00Z'),
    });

    const res = await postWebhook(event);

    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(mockPrisma.companySubscription.update).not.toHaveBeenCalled();
  });

  it('re-runs an event that was claimed but never finished', async () => {
    const event = checkoutCompletedEvent();
    mockStripe.webhooks.constructEvent.mockReturnValue(event);
    mockPrisma.stripeEvent.findUnique.mockResolvedValue({
      id: 1,
      stripeEventId: 'evt_1',
      processedAt: null,
    });

    const res = await postWebhook(event);

    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(false);
    expect(mockPrisma.companySubscription.update).toHaveBeenCalled();
  });

  it('treats a lost insert race as a duplicate when the winner finished', async () => {
    const event = checkoutCompletedEvent();
    mockStripe.webhooks.constructEvent.mockReturnValue(event);
    mockPrisma.stripeEvent.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    mockPrisma.stripeEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 1, processedAt: new Date() });

    const res = await postWebhook(event);

    expect(res.body.duplicate).toBe(true);
  });

  it('leaves the event unprocessed when the handler throws, so Stripe retries', async () => {
    const event = checkoutCompletedEvent();
    mockStripe.webhooks.constructEvent.mockReturnValue(event);
    mockPrisma.companySubscription.update.mockRejectedValue(new Error('database is down'));

    const res = await postWebhook(event);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('WEBHOOK_PROCESSING_FAILED');
    expect(mockPrisma.stripeEvent.update).not.toHaveBeenCalled();
  });

  it('acknowledges an event type it does not handle', async () => {
    const event = { id: 'evt_x', type: 'customer.updated', data: { object: {} } };
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    const res = await postWebhook(event);

    expect(res.status).toBe(200);
    expect(mockPrisma.stripeEvent.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { processedAt: expect.any(Date) },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* checkout.session.completed                                                  */
/* -------------------------------------------------------------------------- */

describe('checkout.session.completed', () => {
  it('activates the subscription and stores the Stripe ids', async () => {
    const event = checkoutCompletedEvent();
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    const res = await postWebhook(event);

    expect(res.status).toBe(200);
    expect(mockPrisma.companySubscription.update).toHaveBeenCalledWith({
      where: { id: SUB_ID },
      data: expect.objectContaining({
        status: 'ACTIVE',
        stripeSubscriptionId: 'sub_live_1',
        cancelAtPeriodEnd: false,
        currentPeriodStart: new Date(1_800_000_000 * 1000),
        currentPeriodEnd: new Date(1_802_678_400 * 1000),
      }),
    });
  });

  it('re-validates every billed price against the catalog', async () => {
    const event = checkoutCompletedEvent();
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    expect(mockStripe.checkout.sessions.listLineItems).toHaveBeenCalledWith(SESSION_ID, { limit: 100 });
    expect(mockPrisma.servicePlan.findMany).toHaveBeenCalledWith({
      where: { stripePriceId: { in: ['price_book_2', 'price_pay_employee'] } },
    });
  });

  it('writes the Stripe subscription-item id onto our matching line', async () => {
    const event = checkoutCompletedEvent();
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    expect(mockPrisma.companySubscriptionItem.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { quantity: 1, stripeSubscriptionItemId: 'si_1' },
    });
    expect(mockPrisma.companySubscriptionItem.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: { quantity: 12, stripeSubscriptionItemId: 'si_2' },
    });
  });

  it('corrects a local quantity that disagrees with what Stripe billed', async () => {
    mockStripe.checkout.sessions.listLineItems.mockResolvedValue({
      data: [{ id: 'li_2', quantity: 9, price: { id: 'price_pay_employee', product: 'prod_pay' } }],
    });
    const event = checkoutCompletedEvent();
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    expect(mockPrisma.companySubscriptionItem.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: expect.objectContaining({ quantity: 9 }),
    });
  });

  it('does not activate a line item whose price is not in our catalog', async () => {
    mockStripe.checkout.sessions.listLineItems.mockResolvedValue({
      data: [
        { id: 'li_1', quantity: 1, price: { id: 'price_book_2', product: 'prod_book' } },
        { id: 'li_bad', quantity: 1, price: { id: 'price_unknown', product: 'prod_evil' } },
      ],
    });
    mockPrisma.servicePlan.findMany.mockResolvedValue([BOOKKEEPING_PLAN]);
    const event = checkoutCompletedEvent();
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    const res = await postWebhook(event);

    expect(res.status).toBe(200);
    const updatedItemIds = mockPrisma.companySubscriptionItem.update.mock.calls.map((c) => c[0].where.id);
    expect(updatedItemIds).toEqual([11]);
  });

  it('does not activate a price billed under the wrong product', async () => {
    mockStripe.checkout.sessions.listLineItems.mockResolvedValue({
      data: [{ id: 'li_1', quantity: 1, price: { id: 'price_book_2', product: 'prod_somebody_else' } }],
    });
    const event = checkoutCompletedEvent();
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    expect(mockPrisma.companySubscriptionItem.update).not.toHaveBeenCalled();
  });

  it('refuses a session whose metadata names a different company', async () => {
    const event = checkoutCompletedEvent({ metadata: { company_id: '999' } });
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    const res = await postWebhook(event);

    expect(res.status).toBe(200);
    expect(mockPrisma.companySubscription.update).not.toHaveBeenCalled();
  });

  it('acknowledges a session this backend never created', async () => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(null);
    const event = checkoutCompletedEvent();
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    const res = await postWebhook(event);

    expect(res.status).toBe(200);
    expect(mockPrisma.companySubscription.update).not.toHaveBeenCalled();
  });

  it('reads the period from the subscription ITEMS on newer API versions', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_live_1',
      status: 'active',
      cancel_at_period_end: false,
      items: {
        data: [
          { id: 'si_1', price: { id: 'price_book_2' }, current_period_start: 1_800_000_000, current_period_end: 1_802_678_400 },
          { id: 'si_2', price: { id: 'price_pay_employee' }, current_period_start: 1_800_000_000, current_period_end: 1_802_678_400 },
        ],
      },
    });
    const event = checkoutCompletedEvent();
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    expect(mockPrisma.companySubscription.update).toHaveBeenCalledWith({
      where: { id: SUB_ID },
      data: expect.objectContaining({
        currentPeriodEnd: new Date(1_802_678_400 * 1000),
      }),
    });
  });

  /*
   * The regression this file did not have.
   *
   * Stripe routinely delivers invoice.paid and customer.subscription.created
   * BEFORE checkout.session.completed. Those stamp `last_stripe_event_at`, so the
   * checkout event then looks stale — and this handler is the only writer of
   * `stripe_subscription_item_id`. Skipping it wholesale left every item id null
   * for good, which silently broke the next payroll head-count change.
   */
  describe('arriving after a newer event (out of order)', () => {
    const LATER = new Date((EVENT_AT + 30) * 1000);

    beforeEach(() => {
      mockPrisma.companySubscription.findUnique.mockResolvedValue(
        subscriptionRow({ status: 'ACTIVE', lastStripeEventAt: LATER })
      );
    });

    it('still links the Stripe subscription-item ids', async () => {
      const event = checkoutCompletedEvent();
      mockStripe.webhooks.constructEvent.mockReturnValue(event);

      const res = await postWebhook(event);

      expect(res.status).toBe(200);
      expect(mockPrisma.companySubscriptionItem.update).toHaveBeenCalledWith({
        where: { id: 11 },
        data: { quantity: 1, stripeSubscriptionItemId: 'si_1' },
      });
      expect(mockPrisma.companySubscriptionItem.update).toHaveBeenCalledWith({
        where: { id: 12 },
        data: { quantity: 12, stripeSubscriptionItemId: 'si_2' },
      });
    });

    it('links the Stripe subscription id but withholds status and period', async () => {
      const event = checkoutCompletedEvent();
      mockStripe.webhooks.constructEvent.mockReturnValue(event);

      await postWebhook(event);

      expect(mockPrisma.companySubscription.update).toHaveBeenCalledWith({
        where: { id: SUB_ID },
        data: { stripeSubscriptionId: 'sub_live_1' },
      });
    });

    it('does not move a subscription the newer event already cancelled', async () => {
      mockPrisma.companySubscription.findUnique.mockResolvedValue(
        subscriptionRow({ status: 'CANCELED', stripeSubscriptionId: 'sub_live_1', lastStripeEventAt: LATER })
      );
      const event = checkoutCompletedEvent();
      mockStripe.webhooks.constructEvent.mockReturnValue(event);

      await postWebhook(event);

      // Nothing left to link, and no state may be applied — so no write at all.
      expect(mockPrisma.companySubscription.update).not.toHaveBeenCalled();
      // The item ids are still repaired, because that is what was missing.
      expect(mockPrisma.companySubscriptionItem.update).toHaveBeenCalledTimes(2);
    });
  });

  it('marks the subscription UNPAID when an async payment fails', async () => {
    const event = {
      id: 'evt_async_fail',
      created: EVENT_AT,
      type: 'checkout.session.async_payment_failed',
      data: { object: { id: SESSION_ID, metadata: { company_id: String(COMPANY_ID) } } },
    };
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    expect(mockPrisma.companySubscription.update).toHaveBeenCalledWith({
      where: { id: SUB_ID },
      data: { status: 'UNPAID', lastStripeEventAt: new Date(EVENT_AT * 1000) },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* subscription lifecycle                                                      */
/* -------------------------------------------------------------------------- */

describe('subscription lifecycle', () => {
  function lifecycleEvent(type, subscription, created = EVENT_AT) {
    return { id: `evt_${type}`, created, type, data: { object: { id: 'sub_live_1', ...subscription } } };
  }

  it('records a cancellation', async () => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(
      subscriptionRow({ status: 'ACTIVE', stripeSubscriptionId: 'sub_live_1' })
    );
    const event = lifecycleEvent('customer.subscription.deleted', {
      status: 'canceled',
      canceled_at: 1_802_678_400,
      cancel_at_period_end: false,
      items: { data: [] },
    });
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    expect(mockPrisma.companySubscription.update).toHaveBeenCalledWith({
      where: { id: SUB_ID },
      data: expect.objectContaining({ status: 'CANCELED', canceledAt: new Date(1_802_678_400 * 1000) }),
    });
  });

  it('ignores an out-of-order event that would resurrect a cancelled subscription', async () => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(
      subscriptionRow({ status: 'CANCELED', stripeSubscriptionId: 'sub_live_1' })
    );
    const event = lifecycleEvent('customer.subscription.updated', {
      status: 'active',
      items: { data: [] },
    });
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    const res = await postWebhook(event);

    expect(res.status).toBe(200);
    expect(mockPrisma.companySubscription.update).not.toHaveBeenCalled();
  });

  it('maps past_due through to PAST_DUE', async () => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(
      subscriptionRow({ status: 'ACTIVE', stripeSubscriptionId: 'sub_live_1' })
    );
    const event = lifecycleEvent('customer.subscription.updated', {
      status: 'past_due',
      items: { data: [] },
    });
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    expect(mockPrisma.companySubscription.update).toHaveBeenCalledWith({
      where: { id: SUB_ID },
      data: expect.objectContaining({ status: 'PAST_DUE' }),
    });
  });

  it('stamps the high-water mark on every state write', async () => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(
      subscriptionRow({ status: 'ACTIVE', stripeSubscriptionId: 'sub_live_1' })
    );
    const event = lifecycleEvent('customer.subscription.updated', { status: 'past_due', items: { data: [] } });
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    expect(mockPrisma.companySubscription.update).toHaveBeenCalledWith({
      where: { id: SUB_ID },
      data: expect.objectContaining({ lastStripeEventAt: new Date(EVENT_AT * 1000) }),
    });
  });

  it('drops an event created BEFORE the last one applied to the row', async () => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(
      subscriptionRow({
        status: 'ACTIVE',
        stripeSubscriptionId: 'sub_live_1',
        lastStripeEventAt: new Date(EVENT_AT * 1000),
      })
    );
    // A stale past_due, delivered after the active that superseded it.
    const event = lifecycleEvent(
      'customer.subscription.updated',
      { status: 'past_due', items: { data: [] } },
      EVENT_AT - 60
    );
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    const res = await postWebhook(event);

    expect(res.status).toBe(200);
    expect(mockPrisma.companySubscription.update).not.toHaveBeenCalled();
  });

  it('still applies an event created in the SAME second as the mark', async () => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(
      subscriptionRow({
        status: 'ACTIVE',
        stripeSubscriptionId: 'sub_live_1',
        lastStripeEventAt: new Date(EVENT_AT * 1000),
      })
    );
    const event = lifecycleEvent(
      'customer.subscription.updated',
      { status: 'past_due', items: { data: [] } },
      EVENT_AT
    );
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    // Stripe's `created` is second-resolution, so equal timestamps are common
    // between related events and must not be discarded.
    expect(mockPrisma.companySubscription.update).toHaveBeenCalled();
  });

  it('keeps cancellation terminal even when timestamps cannot discriminate', async () => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(
      subscriptionRow({
        status: 'CANCELED',
        stripeSubscriptionId: 'sub_live_1',
        lastStripeEventAt: new Date(EVENT_AT * 1000),
      })
    );
    const event = lifecycleEvent(
      'customer.subscription.updated',
      { status: 'active', items: { data: [] } },
      EVENT_AT
    );
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    expect(mockPrisma.companySubscription.update).not.toHaveBeenCalled();
  });

  it('never maps a paused subscription to ACTIVE', async () => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(
      subscriptionRow({ status: 'ACTIVE', stripeSubscriptionId: 'sub_live_1' })
    );
    const event = lifecycleEvent('customer.subscription.updated', { status: 'paused', items: { data: [] } });
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    const [{ data }] = mockPrisma.companySubscription.update.mock.calls[0];
    expect(data.status).not.toBe('ACTIVE');
  });
});

/* -------------------------------------------------------------------------- */
/* invoices                                                                    */
/* -------------------------------------------------------------------------- */

describe('invoices', () => {
  function invoiceEvent(type, invoice, created = EVENT_AT) {
    return {
      id: `evt_${type}`,
      created,
      type,
      data: {
        object: {
          id: 'in_1',
          currency: 'usd',
          subscription: 'sub_live_1',
          payment_intent: 'pi_1',
          status_transitions: { paid_at: 1_800_000_100 },
          ...invoice,
        },
      },
    };
  }

  beforeEach(() => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(
      subscriptionRow({ status: 'ACTIVE', stripeSubscriptionId: 'sub_live_1' })
    );
  });

  it('records a paid renewal from the invoice amount, not the plan catalog', async () => {
    const event = invoiceEvent('invoice.paid', { amount_paid: 43000 });
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    expect(mockPrisma.companyPayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: COMPANY_ID,
        companySubscriptionId: SUB_ID,
        stripeInvoiceId: 'in_1',
        stripePaymentIntentId: 'pi_1',
        amountPaid: '430.00',
        currency: 'USD',
        status: 'PAID',
      }),
    });
  });

  it('reads the subscription id from the newer invoice.parent shape', async () => {
    const event = invoiceEvent('invoice.paid', {
      amount_paid: 43000,
      subscription: undefined,
      parent: { subscription_details: { subscription: 'sub_live_1' } },
    });
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    expect(mockPrisma.companyPayment.create).toHaveBeenCalled();
  });

  it('marks the subscription PAST_DUE when a renewal fails', async () => {
    const event = invoiceEvent('invoice.payment_failed', { amount_due: 43000 });
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    expect(mockPrisma.companyPayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'FAILED', paidAt: null }),
    });
    expect(mockPrisma.companySubscription.update).toHaveBeenCalledWith({
      where: { id: SUB_ID },
      data: { status: 'PAST_DUE', lastStripeEventAt: new Date(EVENT_AT * 1000) },
    });
  });

  it('restores ACTIVE when a past-due subscription is paid', async () => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(
      subscriptionRow({ status: 'PAST_DUE', stripeSubscriptionId: 'sub_live_1' })
    );
    const event = invoiceEvent('invoice.paid', { amount_paid: 43000 });
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    expect(mockPrisma.companySubscription.update).toHaveBeenCalledWith({
      where: { id: SUB_ID },
      data: { status: 'ACTIVE', lastStripeEventAt: new Date(EVENT_AT * 1000) },
    });
  });

  it('writes the receipt even for an out-of-order invoice, but not the status', async () => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(
      subscriptionRow({
        status: 'PAST_DUE',
        stripeSubscriptionId: 'sub_live_1',
        lastStripeEventAt: new Date(EVENT_AT * 1000),
      })
    );
    const event = invoiceEvent('invoice.paid', { amount_paid: 43000 }, EVENT_AT - 60);
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    // Dropping the receipt would lose a payment record; it is idempotent on
    // stripe_invoice_id, so writing it out of order is safe. The status move is
    // not, so it is skipped.
    expect(mockPrisma.companyPayment.create).toHaveBeenCalled();
    expect(mockPrisma.companySubscription.update).not.toHaveBeenCalled();
  });

  it('updates rather than duplicates a re-delivered invoice', async () => {
    mockPrisma.companyPayment.findUnique.mockResolvedValue({ id: 55, stripeInvoiceId: 'in_1' });
    const event = invoiceEvent('invoice.paid', { amount_paid: 43000 });
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    expect(mockPrisma.companyPayment.create).not.toHaveBeenCalled();
    expect(mockPrisma.companyPayment.update).toHaveBeenCalledWith({
      where: { id: 55 },
      data: expect.objectContaining({ status: 'PAID' }),
    });
  });
});

/* -------------------------------------------------------------------------- */
/* one-time payments (mode: 'payment')                                         */
/* -------------------------------------------------------------------------- */

describe('payment intents', () => {
  function intentEvent(type, intent) {
    return {
      id: `evt_${type}`,
      created: EVENT_AT,
      type,
      data: {
        object: {
          id: 'pi_1',
          amount: 23300,
          amount_received: 23300,
          currency: 'usd',
          metadata: { company_subscription_id: String(SUB_ID) },
          ...intent,
        },
      },
    };
  }

  beforeEach(() => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(subscriptionRow({ status: 'INCOMPLETE' }));
  });

  it('records a receipt for a one-time purchase that has no invoice', async () => {
    const event = intentEvent('payment_intent.succeeded');
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    expect(mockPrisma.companyPayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        stripePaymentIntentId: 'pi_1',
        amountPaid: '233.00',
        currency: 'USD',
        status: 'PAID',
      }),
    });
    expect(mockPrisma.companySubscription.update).toHaveBeenCalledWith({
      where: { id: SUB_ID },
      data: { status: 'ACTIVE', lastStripeEventAt: new Date(EVENT_AT * 1000) },
    });
  });

  it('does not duplicate the receipt when an invoice already covered it', async () => {
    const event = intentEvent('payment_intent.succeeded', { invoice: 'in_1' });
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    expect(mockPrisma.companyPayment.create).not.toHaveBeenCalled();
  });

  it('swallows the unique violation when the same intent is redelivered', async () => {
    mockPrisma.companyPayment.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    const event = intentEvent('payment_intent.succeeded');
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    const res = await postWebhook(event);

    expect(res.status).toBe(200);
    expect(mockPrisma.companySubscription.update).toHaveBeenCalled();
  });

  it('marks the subscription UNPAID when the intent fails', async () => {
    const event = intentEvent('payment_intent.payment_failed');
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    await postWebhook(event);

    expect(mockPrisma.companyPayment.create).not.toHaveBeenCalled();
    expect(mockPrisma.companySubscription.update).toHaveBeenCalledWith({
      where: { id: SUB_ID },
      data: { status: 'UNPAID', lastStripeEventAt: new Date(EVENT_AT * 1000) },
    });
  });

  it('ignores an intent with no subscription metadata', async () => {
    const event = intentEvent('payment_intent.succeeded', { metadata: {} });
    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    const res = await postWebhook(event);

    expect(res.status).toBe(200);
    expect(mockPrisma.companySubscription.update).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* GET /billing/checkout-status                                                */
/* -------------------------------------------------------------------------- */

describe('GET /billing/checkout-status', () => {
  beforeEach(() => {
    mockStripe.checkout.sessions.retrieve.mockResolvedValue({
      id: SESSION_ID,
      status: 'complete',
      payment_status: 'paid',
    });
  });

  function get(sessionId = SESSION_ID, header = auth()) {
    return request(app)
      .get(`/api/billing/checkout-status?session_id=${sessionId}`)
      .set('Authorization', header);
  }

  it('requires authentication', async () => {
    const res = await request(app).get(`/api/billing/checkout-status?session_id=${SESSION_ID}`);
    expect(res.status).toBe(401);
  });

  it('reports a paid subscription with its per-service breakdown', async () => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(subscriptionRow({ status: 'ACTIVE' }));

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'paid',
      checkoutStatus: 'complete',
      paymentStatus: 'paid',
      companyId: COMPANY_ID,
      subscriptionStatus: 'ACTIVE',
    });
    expect(res.body.data.services).toEqual(
      expect.arrayContaining([
        { service: 'bookkeeping', status: 'active', priceOptionId: 'bookkeeping_option_2' },
        {
          service: 'payroll',
          status: 'active',
          planId: 'payroll_standard',
          employeeCount: 12,
          contractorCount: 0,
        },
      ])
    );
  });

  it('reports "processing" for a completed session whose payment has not settled', async () => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(subscriptionRow({ status: 'INCOMPLETE' }));
    mockStripe.checkout.sessions.retrieve.mockResolvedValue({
      id: SESSION_ID,
      status: 'complete',
      payment_status: 'unpaid',
    });

    const res = await get();

    expect(res.body.data.status).toBe('processing');
  });

  it('reports "pending" while the session is still open', async () => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(subscriptionRow({ status: 'INCOMPLETE' }));
    mockStripe.checkout.sessions.retrieve.mockResolvedValue({
      id: SESSION_ID,
      status: 'open',
      payment_status: 'unpaid',
    });

    const res = await get();

    expect(res.body.data.status).toBe('pending');
  });

  it('reports "cancelled" for an expired session', async () => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(subscriptionRow({ status: 'INCOMPLETE' }));
    mockStripe.checkout.sessions.retrieve.mockResolvedValue({
      id: SESSION_ID,
      status: 'expired',
      payment_status: 'unpaid',
    });

    const res = await get();

    expect(res.body.data.status).toBe('cancelled');
  });

  it('reports "failed" for a past-due subscription', async () => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(subscriptionRow({ status: 'PAST_DUE' }));

    const res = await get();

    expect(res.body.data.status).toBe('failed');
  });

  it('denies a caller who does not own the session\'s company', async () => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(subscriptionRow({ status: 'ACTIVE' }));
    mockPrisma.company.findFirst.mockResolvedValue(companyRow({ ownerUserId: 7 }));

    const res = await get();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CHECKOUT_SESSION_ACCESS_DENIED');
    expect(mockStripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  it('404s for a session this backend did not create', async () => {
    mockPrisma.companySubscription.findUnique.mockResolvedValue(null);

    const res = await get();

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CHECKOUT_SESSION_NOT_FOUND');
  });

  it('rejects a malformed session id before calling Stripe', async () => {
    const res = await get('not-a-session-id');

    expect(res.status).toBe(400);
    expect(mockStripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  it('requires the session_id parameter', async () => {
    const res = await request(app).get('/api/billing/checkout-status').set('Authorization', auth());

    expect(res.status).toBe(400);
  });
});
