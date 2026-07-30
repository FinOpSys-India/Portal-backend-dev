'use strict';

/**
 * Integration tests for the service-selection / Stripe Checkout flow, driven
 * through the real Express app with Prisma and Stripe both mocked — no database
 * and no network. Stripe is mocked at the client boundary (src/config/stripe), so
 * everything under test is our own resolution, validation, and pricing logic.
 *
 * NO TEST HERE CREATES A REAL CHARGE. Every Stripe call is a jest.fn().
 *
 * The `mock`-prefixed names are required: jest.mock is hoisted above the imports
 * and its factory may only close over variables whose names begin with "mock".
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
const planCatalogService = require('../src/services/planCatalogService');

const USER_ID = 42;
const COMPANY_ID = 900;

/** A Bearer header for the company OWNER by default. */
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

/**
 * The seeded catalog, as service_plans rows. Amounts mirror the real seed so the
 * arithmetic assertions below are the arithmetic the customer would see.
 */
const PLANS = {
  BOOKKEEPING_STARTER: { id: 1, planCode: 'BOOKKEEPING_STARTER', planName: 'Bookkeeping Starter', stripeProductId: 'prod_book', stripePriceId: 'price_book_1', amount: '99.00', currency: 'USD', billingInterval: 'MONTH', isActive: true, displayOrder: 10 },
  BOOKKEEPING_GROWTH: { id: 2, planCode: 'BOOKKEEPING_GROWTH', planName: 'Bookkeeping Growth', stripeProductId: 'prod_book', stripePriceId: 'price_book_2', amount: '249.00', currency: 'USD', billingInterval: 'MONTH', isActive: true, displayOrder: 20 },
  BOOKKEEPING_SCALE: { id: 3, planCode: 'BOOKKEEPING_SCALE', planName: 'Bookkeeping Scale', stripeProductId: 'prod_book', stripePriceId: 'price_book_3', amount: '499.00', currency: 'USD', billingInterval: 'MONTH', isActive: true, displayOrder: 30 },
  BOOKKEEPING_PREMIUM: { id: 4, planCode: 'BOOKKEEPING_PREMIUM', planName: 'Bookkeeping Premium', stripeProductId: 'prod_book', stripePriceId: 'price_book_4', amount: '799.00', currency: 'USD', billingInterval: 'MONTH', isActive: true, displayOrder: 40 },
  TAX_UNDER_500K: { id: 5, planCode: 'TAX_UNDER_500K', planName: 'Tax - Under $500K', stripeProductId: 'prod_tax', stripePriceId: 'price_tax_1', amount: '63.00', currency: 'USD', billingInterval: 'MONTH', isActive: true, displayOrder: 10 },
  TAX_500K_TO_2M: { id: 6, planCode: 'TAX_500K_TO_2M', planName: 'Tax - $500K to $2M', stripeProductId: 'prod_tax', stripePriceId: 'price_tax_2', amount: '125.00', currency: 'USD', billingInterval: 'MONTH', isActive: true, displayOrder: 20 },
  TAX_2M_TO_10M: { id: 7, planCode: 'TAX_2M_TO_10M', planName: 'Tax - $2M to $10M', stripeProductId: 'prod_tax', stripePriceId: 'price_tax_3', amount: '233.00', currency: 'USD', billingInterval: 'MONTH', isActive: true, displayOrder: 30 },
  PAYROLL_BASE: { id: 8, planCode: 'PAYROLL_BASE', planName: 'Payroll Base', stripeProductId: 'prod_pay', stripePriceId: 'price_pay_base', amount: '29.00', currency: 'USD', billingInterval: 'MONTH', isActive: true, displayOrder: 10 },
  PAYROLL_1099_CONTRACTOR: { id: 9, planCode: 'PAYROLL_1099_CONTRACTOR', planName: '1099 Contractor Add-On', stripeProductId: 'prod_pay', stripePriceId: 'price_pay_contractor', amount: '10.00', currency: 'USD', billingInterval: 'MONTH', isActive: true, isAddOn: true, quantityEnabled: true, quantityLabel: 'Number of 1099 Contractors', displayOrder: 20 },
  PAYROLL_W2_EMPLOYEE: { id: 10, planCode: 'PAYROLL_W2_EMPLOYEE', planName: 'W-2 Employee Add-On', stripeProductId: 'prod_pay', stripePriceId: 'price_pay_employee', amount: '15.00', currency: 'USD', billingInterval: 'MONTH', isActive: true, isAddOn: true, quantityEnabled: true, quantityLabel: 'Number of W-2 Employees', displayOrder: 30 },
};

/** Serve service_plans lookups out of PLANS, honouring the isActive filter. */
function stubPlanLookup(overrides = {}) {
  const table = { ...PLANS, ...overrides };
  mockPrisma.servicePlan.findMany.mockImplementation(async ({ where }) => {
    const codes = where.planCode?.in ?? [];
    return codes
      .map((code) => table[code])
      .filter((plan) => plan && (where.isActive === undefined || plan.isActive === where.isActive));
  });
}

/** A Stripe Price object matching a catalog row. */
function stripePrice(plan, overrides = {}) {
  return {
    id: plan.stripePriceId,
    object: 'price',
    active: true,
    currency: plan.currency.toLowerCase(),
    product: plan.stripeProductId,
    recurring: { interval: plan.billingInterval.toLowerCase(), interval_count: 1 },
    type: 'recurring',
    unit_amount: Math.round(Number(plan.amount) * 100),
    ...overrides,
  };
}

/** Resolve prices.retrieve out of the catalog, with per-price overrides. */
function stubStripePrices(overrides = {}) {
  const byId = {};
  for (const plan of Object.values(PLANS)) {
    byId[plan.stripePriceId] = stripePrice(plan, overrides[plan.stripePriceId] ?? {});
  }
  mockStripe.prices.retrieve.mockImplementation(async (id) => {
    if (!byId[id]) {
      const err = new Error('No such price');
      err.statusCode = 404;
      err.code = 'resource_missing';
      throw err;
    }
    return byId[id];
  });
}

function checkoutBody(overrides = {}) {
  return {
    company_id: COMPANY_ID,
    selected_services: {
      bookkeeping: { selected: true, price_option_id: 'bookkeeping_option_2' },
      ...overrides,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  planCatalogService.clearPriceCache();

  // Live Price verification is off by default under test (config/index forces
  // it); the tests that exercise it turn it on explicitly.
  config.stripe.verifyPricesWithApi = false;
  config.billing.exposeStripeIds = true;

  mockPrisma.user.findUnique.mockResolvedValue(ownerUser());
  mockPrisma.company.findFirst.mockResolvedValue(companyRow());
  mockPrisma.company.update.mockImplementation(async ({ data }) => companyRow(data));
  mockPrisma.companySubscription.findFirst.mockResolvedValue(null);
  mockPrisma.companySubscription.create.mockResolvedValue({ id: 7001, companyId: COMPANY_ID, status: 'INCOMPLETE' });
  mockPrisma.companySubscription.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
  mockPrisma.companySubscriptionItem.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
  mockPrisma.idempotencyKey.findUnique.mockResolvedValue(null);
  mockPrisma.idempotencyKey.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));

  mockStripe.customers.retrieve.mockResolvedValue({ id: 'cus_existing', deleted: false });
  mockStripe.customers.create.mockResolvedValue({ id: 'cus_new' });
  mockStripe.checkout.sessions.create.mockResolvedValue({
    id: 'cs_test_123',
    url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    status: 'open',
  });

  stubPlanLookup();
  stubStripePrices();
});

/* -------------------------------------------------------------------------- */
/* every bookkeeping and tax price option                                     */
/* -------------------------------------------------------------------------- */

describe('price option coverage', () => {
  const BOOKKEEPING = [
    ['bookkeeping_option_1', 'price_book_1', 9900],
    ['bookkeeping_option_2', 'price_book_2', 24900],
    ['bookkeeping_option_3', 'price_book_3', 49900],
    ['bookkeeping_option_4', 'price_book_4', 79900],
  ];

  it.each(BOOKKEEPING)('resolves %s to %s at %i minor units', async (optionId, priceId, amount) => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({
        company_id: COMPANY_ID,
        selected_services: { bookkeeping: { selected: true, price_option_id: optionId } },
      });

    expect(res.status).toBe(201);
    expect(res.body.data.pricing_summary.bookkeeping).toMatchObject({
      price_id: priceId,
      quantity: 1,
      unit_amount: amount,
      total_amount: amount,
    });
    expect(res.body.data.pricing_summary.grand_total_amount).toBe(amount);

    const [args] = mockStripe.checkout.sessions.create.mock.calls[0];
    expect(args.line_items).toEqual([{ price: priceId, quantity: 1 }]);
    expect(args.mode).toBe('subscription');
  });

  const TAX = [
    ['tax_option_1', 'price_tax_1', 6300],
    ['tax_option_2', 'price_tax_2', 12500],
    ['tax_option_3', 'price_tax_3', 23300],
  ];

  it.each(TAX)('resolves %s to %s at %i minor units', async (optionId, priceId, amount) => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({
        company_id: COMPANY_ID,
        selected_services: { taxes: { selected: true, price_option_id: optionId } },
      });

    expect(res.status).toBe(201);
    expect(res.body.data.pricing_summary.taxes).toMatchObject({ price_id: priceId, unit_amount: amount });
  });
});

/* -------------------------------------------------------------------------- */
/* service combinations                                                        */
/* -------------------------------------------------------------------------- */

describe('service combinations', () => {
  it('bills payroll as base + employees + contractors, computed server-side', async () => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({
        company_id: COMPANY_ID,
        selected_services: {
          payroll: { selected: true, plan_id: 'payroll_standard', employee_count: 12, contractor_count: 4 },
        },
      });

    expect(res.status).toBe(201);
    const { payroll, grand_total_amount } = res.body.data.pricing_summary;

    // 2900 + (12 x 1500) + (4 x 1000) = 2900 + 18000 + 4000 = 24900
    expect(payroll.base).toMatchObject({ quantity: 1, unit_amount: 2900, total_amount: 2900 });
    expect(payroll.employees).toMatchObject({ quantity: 12, unit_amount: 1500, total_amount: 18000 });
    expect(payroll.contractors).toMatchObject({ quantity: 4, unit_amount: 1000, total_amount: 4000 });
    expect(payroll.total_amount).toBe(24900);
    expect(grand_total_amount).toBe(24900);

    const [args] = mockStripe.checkout.sessions.create.mock.calls[0];
    expect(args.line_items).toEqual([
      { price: 'price_pay_base', quantity: 1 },
      { price: 'price_pay_employee', quantity: 12 },
      { price: 'price_pay_contractor', quantity: 4 },
    ]);
  });

  it('omits the employee line entirely when the count is zero', async () => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({
        company_id: COMPANY_ID,
        selected_services: {
          payroll: { selected: true, plan_id: 'payroll_standard', employee_count: 0, contractor_count: 3 },
        },
      });

    expect(res.status).toBe(201);
    const [args] = mockStripe.checkout.sessions.create.mock.calls[0];
    expect(args.line_items.map((l) => l.price)).toEqual(['price_pay_base', 'price_pay_contractor']);
    // Still reported, as an explicit zero, so the client can render a stable table.
    expect(res.body.data.pricing_summary.payroll.employees).toEqual({
      quantity: 0,
      unit_amount: 0,
      total_amount: 0,
    });
  });

  it('omits the contractor line entirely when the count is zero', async () => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({
        company_id: COMPANY_ID,
        selected_services: {
          payroll: { selected: true, plan_id: 'payroll_standard', employee_count: 5 },
        },
      });

    expect(res.status).toBe(201);
    const [args] = mockStripe.checkout.sessions.create.mock.calls[0];
    expect(args.line_items.map((l) => l.price)).toEqual(['price_pay_base', 'price_pay_employee']);
  });

  it('always bills the payroll base, even with both counts at zero', async () => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({
        company_id: COMPANY_ID,
        selected_services: {
          payroll: { selected: true, plan_id: 'payroll_standard', employee_count: 0, contractor_count: 0 },
        },
      });

    expect(res.status).toBe(201);
    const [args] = mockStripe.checkout.sessions.create.mock.calls[0];
    expect(args.line_items).toEqual([{ price: 'price_pay_base', quantity: 1 }]);
  });

  it('puts all three services in ONE checkout session', async () => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({
        company_id: COMPANY_ID,
        selected_services: {
          bookkeeping: { selected: true, price_option_id: 'bookkeeping_option_2' },
          payroll: { selected: true, plan_id: 'payroll_standard', employee_count: 12, contractor_count: 4 },
          taxes: { selected: true, price_option_id: 'tax_option_3' },
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.data.selected_services).toEqual(['bookkeeping', 'payroll', 'taxes']);
    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledTimes(1);

    const [args] = mockStripe.checkout.sessions.create.mock.calls[0];
    expect(args.line_items).toEqual([
      { price: 'price_book_2', quantity: 1 },
      { price: 'price_pay_base', quantity: 1 },
      { price: 'price_pay_employee', quantity: 12 },
      { price: 'price_pay_contractor', quantity: 4 },
      { price: 'price_tax_3', quantity: 1 },
    ]);

    // 24900 (bookkeeping) + 24900 (payroll) + 23300 (tax)
    expect(res.body.data.pricing_summary.grand_total_amount).toBe(73100);
  });

  it('rejects a request that selects nothing', async () => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({
        company_id: COMPANY_ID,
        selected_services: { bookkeeping: { selected: false, price_option_id: 'bookkeeping_option_1' } },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_SERVICE_SELECTED');
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* quantity validation                                                         */
/* -------------------------------------------------------------------------- */

describe('payroll quantity validation', () => {
  function withCounts(counts) {
    return request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({
        company_id: COMPANY_ID,
        selected_services: { payroll: { selected: true, plan_id: 'payroll_standard', ...counts } },
      });
  }

  it.each([
    ['negative employee count', { employee_count: -1 }, 'INVALID_EMPLOYEE_COUNT'],
    ['negative contractor count', { contractor_count: -5 }, 'INVALID_CONTRACTOR_COUNT'],
    ['decimal employee count', { employee_count: 2.5 }, 'INVALID_EMPLOYEE_COUNT'],
    ['decimal contractor count string', { contractor_count: '3.5' }, 'INVALID_CONTRACTOR_COUNT'],
    ['non-numeric employee count', { employee_count: 'twelve' }, 'INVALID_EMPLOYEE_COUNT'],
    ['boolean contractor count', { contractor_count: true }, 'INVALID_CONTRACTOR_COUNT'],
    ['array employee count', { employee_count: [1] }, 'INVALID_EMPLOYEE_COUNT'],
    ['exponent notation', { employee_count: '1e3' }, 'INVALID_EMPLOYEE_COUNT'],
  ])('rejects %s', async (_label, counts, code) => {
    const res = await withCounts(counts);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects an extremely large quantity above the configured ceiling', async () => {
    const res = await withCounts({ employee_count: 10_000_000 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_EMPLOYEE_COUNT');
  });

  it('accepts a count at exactly the ceiling', async () => {
    const res = await withCounts({ employee_count: config.billing.maxEmployeeCount });
    expect(res.status).toBe(201);
  });
});

/* -------------------------------------------------------------------------- */
/* client-supplied Stripe ids and prices                                       */
/* -------------------------------------------------------------------------- */

describe('client cannot supply pricing', () => {
  it.each([
    ['a fake price id', { price_id: 'price_evil' }],
    ['a fake Stripe price id', { stripe_price_id: 'price_evil' }],
    ['a fake product id', { stripe_product_id: 'prod_evil' }],
    ['a custom unit amount', { unit_amount: 1 }],
  ])('rejects %s smuggled into the bookkeeping block', async (_label, extra) => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({
        company_id: COMPANY_ID,
        selected_services: {
          bookkeeping: { selected: true, price_option_id: 'bookkeeping_option_1', ...extra },
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects a total supplied at the top level', async () => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({ ...checkoutBody(), total_amount: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('ignores a user_id in the body and bills as the token subject', async () => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({ ...checkoutBody(), user_id: 999 });

    // Rejected outright rather than silently dropped, so a probe gets an answer
    // rather than a false sense that it worked.
    expect(res.status).toBe(400);
    expect(res.body.error.details.unknown).toContain('user_id');
  });

  it('rejects an unknown bookkeeping option id', async () => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({
        company_id: COMPANY_ID,
        selected_services: { bookkeeping: { selected: true, price_option_id: 'bookkeeping_option_99' } },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BOOKKEEPING_PRICE_OPTION');
  });

  it('rejects an unknown tax option id', async () => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({
        company_id: COMPANY_ID,
        selected_services: { taxes: { selected: true, price_option_id: 'tax_option_9' } },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TAX_PRICE_OPTION');
  });

  it('rejects an unknown payroll plan id', async () => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({
        company_id: COMPANY_ID,
        selected_services: { payroll: { selected: true, plan_id: 'payroll_free' } },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYROLL_PLAN');
  });

  it('refuses to sell the legacy tax plan, which has no option id', async () => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({
        company_id: COMPANY_ID,
        selected_services: { taxes: { selected: true, price_option_id: 'TAX_LEGACY_1499' } },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TAX_PRICE_OPTION');
  });
});

/* -------------------------------------------------------------------------- */
/* Stripe-side price validation                                                */
/* -------------------------------------------------------------------------- */

describe('live Stripe price validation', () => {
  beforeEach(() => {
    config.stripe.verifyPricesWithApi = true;
  });

  it('accepts a price that is active and belongs to the expected product', async () => {
    const res = await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    expect(res.status).toBe(201);
    expect(mockStripe.prices.retrieve).toHaveBeenCalledWith('price_book_2');
  });

  it('rejects an inactive Stripe price', async () => {
    stubStripePrices({ price_book_2: { active: false } });

    const res = await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('STRIPE_PRICE_INACTIVE');
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects a price that belongs to a different product', async () => {
    stubStripePrices({ price_book_2: { product: 'prod_somebody_elses' } });

    const res = await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('STRIPE_PRODUCT_PRICE_MISMATCH');
  });

  it('accepts an EXPANDED product object, not just an id string', async () => {
    stubStripePrices({ price_book_2: { product: { id: 'prod_book', object: 'product' } } });

    const res = await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    expect(res.status).toBe(201);
  });

  it('rejects a price in an unsupported currency', async () => {
    stubStripePrices({ price_book_2: { currency: 'eur' } });

    const res = await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('STRIPE_PRICE_CURRENCY_MISMATCH');
  });

  it('rejects a price whose billing interval disagrees with the catalog', async () => {
    stubStripePrices({ price_book_2: { recurring: { interval: 'year', interval_count: 1 } } });

    const res = await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('STRIPE_PRICE_INTERVAL_MISMATCH');
  });

  it('rejects a price that no longer exists in Stripe', async () => {
    mockStripe.prices.retrieve.mockRejectedValue(
      Object.assign(new Error('No such price'), { statusCode: 404, code: 'resource_missing' })
    );

    const res = await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('STRIPE_PRICE_NOT_FOUND');
  });

  it('refuses to mix a one-time price with recurring ones', async () => {
    stubStripePrices({ price_tax_3: { recurring: null, type: 'one_time' } });

    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({
        company_id: COMPANY_ID,
        selected_services: {
          bookkeeping: { selected: true, price_option_id: 'bookkeeping_option_2' },
          taxes: { selected: true, price_option_id: 'tax_option_3' },
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INCOMPATIBLE_CHECKOUT_PRICES');
    expect(res.body.error.details.reason).toBe('mixed_recurring_and_one_time');
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('uses mode "payment" when every price is one-time', async () => {
    stubStripePrices({ price_tax_3: { recurring: null, type: 'one_time' } });

    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({
        company_id: COMPANY_ID,
        selected_services: { taxes: { selected: true, price_option_id: 'tax_option_3' } },
      });

    expect(res.status).toBe(201);
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].mode).toBe('payment');
  });

  it('rejects a plan that is inactive in our own catalog', async () => {
    stubPlanLookup({ BOOKKEEPING_GROWTH: { ...PLANS.BOOKKEEPING_GROWTH, isActive: false } });

    const res = await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('STRIPE_PRICE_NOT_FOUND');
  });

  it('rejects a catalog row that disagrees with the environment product pin', async () => {
    process.env.STRIPE_BOOKKEEPING_PRODUCT_ID = 'prod_pinned_elsewhere';
    try {
      const res = await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('STRIPE_PRODUCT_PRICE_MISMATCH');
    } finally {
      delete process.env.STRIPE_BOOKKEEPING_PRODUCT_ID;
    }
  });
});

/* -------------------------------------------------------------------------- */
/* authentication and authorization                                            */
/* -------------------------------------------------------------------------- */

describe('authentication and authorization', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/billing/checkout').send(checkoutBody());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('rejects a caller who does not own the company', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(companyRow({ ownerUserId: 7 }));

    const res = await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COMPANY_ACCESS_DENIED');
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('allows an ADMIN to check out for a company they do not own', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(companyRow({ ownerUserId: 7 }));
    mockPrisma.user.findUnique.mockResolvedValue(
      ownerUser({ role: { code: 'ADMIN' }, specificRole: null })
    );

    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth({ role: 'ADMIN', specificRole: null }))
      .send(checkoutBody());

    expect(res.status).toBe(201);
  });

  it('404s for a company that does not exist', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('COMPANY_NOT_FOUND');
  });
});

/* -------------------------------------------------------------------------- */
/* customer reuse, idempotency, failures                                       */
/* -------------------------------------------------------------------------- */

describe('stripe customer handling', () => {
  it('reuses the stored customer instead of creating another', async () => {
    await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    expect(mockStripe.customers.retrieve).toHaveBeenCalledWith('cus_existing');
    expect(mockStripe.customers.create).not.toHaveBeenCalled();
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].customer).toBe('cus_existing');
  });

  it('creates one on first checkout and stores it', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(companyRow({ stripeCustomerId: null }));

    await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    expect(mockStripe.customers.create).toHaveBeenCalledTimes(1);
    /*
     * A per-company Stripe idempotency key is what stops two simultaneous first
     * checkouts producing two customers. The request payload is folded into that
     * key as well, which is why the hash suffix is matched by shape rather than by
     * value: Stripe pins a key to the exact parameters it first saw and rejects a
     * later reuse carrying different ones, so a company that renames or changes
     * its billing email has to get a new key instead of a 400.
     */
    expect(mockStripe.customers.create.mock.calls[0][1]).toEqual({
      idempotencyKey: expect.stringMatching(new RegExp(`^customer:create:${COMPANY_ID}:[0-9a-f]{32}$`)),
    });
    expect(mockPrisma.company.update).toHaveBeenCalledWith({
      where: { id: COMPANY_ID },
      data: { stripeCustomerId: 'cus_new' },
    });
  });

  /*
   * The two halves of why the customer key folds the payload in. Stripe pins an
   * idempotency key to the exact parameters it first saw, so the key has to be
   * stable for an unchanged company and different for a changed one — a key of
   * just the company id satisfies the first and fails the second, turning the
   * next checkout after a rename into a 400.
   */
  it('derives the same customer key for an unchanged company', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(companyRow({ stripeCustomerId: null }));

    await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());
    await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    const [first, second] = mockStripe.customers.create.mock.calls;
    expect(second[1].idempotencyKey).toBe(first[1].idempotencyKey);
  });

  it('derives a different customer key once the company details change', async () => {
    mockPrisma.company.findFirst.mockResolvedValue(companyRow({ stripeCustomerId: null }));
    await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    mockPrisma.company.findFirst.mockResolvedValue(
      companyRow({ stripeCustomerId: null, companyEmail: 'billing@abcaerospace.com' })
    );
    await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    const [first, second] = mockStripe.customers.create.mock.calls;
    expect(second[1].idempotencyKey).not.toBe(first[1].idempotencyKey);
    // Still the same company, so only the hash suffix may differ.
    expect(second[1].idempotencyKey).toMatch(new RegExp(`^customer:create:${COMPANY_ID}:[0-9a-f]{32}$`));
  });

  it('recreates a customer Stripe reports as deleted', async () => {
    mockStripe.customers.retrieve.mockResolvedValue({ id: 'cus_existing', deleted: true });

    await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    expect(mockStripe.customers.create).toHaveBeenCalledTimes(1);
  });
});

describe('duplicate requests', () => {
  it('replays the stored session for a repeated click while it is still open', async () => {
    const first = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send(checkoutBody());
    expect(first.status).toBe(201);

    // Stage the record the first request wrote.
    const stored = mockPrisma.idempotencyKey.create.mock.calls[0][0].data;
    mockPrisma.idempotencyKey.findUnique.mockResolvedValue({ id: 1, ...stored });
    mockStripe.checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_test_123', status: 'open' });
    mockStripe.checkout.sessions.create.mockClear();

    const second = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send(checkoutBody());

    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.data.checkout_session_id).toBe('cs_test_123');
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('creates a fresh session when the stored one has expired', async () => {
    await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    const stored = mockPrisma.idempotencyKey.create.mock.calls[0][0].data;
    mockPrisma.idempotencyKey.findUnique.mockResolvedValue({ id: 1, ...stored });
    mockStripe.checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_test_123', status: 'expired' });
    mockStripe.checkout.sessions.create.mockClear().mockResolvedValue({
      id: 'cs_test_456',
      url: 'https://checkout.stripe.com/c/pay/cs_test_456',
      status: 'open',
    });

    const second = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send(checkoutBody());

    expect(second.status).toBe(201);
    expect(second.body.data.checkout_session_id).toBe('cs_test_456');
  });

  it('rejects an Idempotency-Key reused with a different selection', async () => {
    mockPrisma.idempotencyKey.findUnique.mockResolvedValue({
      id: 1,
      requestHash: 'a-different-payload',
      responseStatus: 201,
      responseBody: { data: { checkout_session_id: 'cs_old' } },
    });

    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .set('Idempotency-Key', 'client-key-1')
      .send(checkoutBody());

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses a second subscription while one is already active', async () => {
    mockPrisma.companySubscription.findFirst.mockResolvedValue({ id: 5000, status: 'ACTIVE', items: [] });

    const res = await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe('failure handling', () => {
  it('returns CHECKOUT_SESSION_CREATION_FAILED when Stripe rejects the session', async () => {
    mockStripe.checkout.sessions.create.mockRejectedValue(new Error('Stripe is down'));

    const res = await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('CHECKOUT_SESSION_CREATION_FAILED');
    // The pending subscription was written first, so an abandoned attempt stays
    // visible instead of vanishing.
    expect(mockPrisma.companySubscription.create).toHaveBeenCalled();
  });

  it('never leaks the underlying Stripe error message to the client', async () => {
    mockStripe.checkout.sessions.create.mockRejectedValue(new Error('sk_live_xxx is invalid'));

    const res = await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    expect(JSON.stringify(res.body)).not.toContain('sk_live');
  });
});

/* -------------------------------------------------------------------------- */
/* records written before the redirect                                         */
/* -------------------------------------------------------------------------- */

describe('records written before redirect', () => {
  it('writes an INCOMPLETE subscription with one item per line', async () => {
    await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({
        company_id: COMPANY_ID,
        selected_services: {
          payroll: { selected: true, plan_id: 'payroll_standard', employee_count: 12, contractor_count: 4 },
        },
      });

    expect(mockPrisma.companySubscription.create).toHaveBeenCalledWith({
      data: { companyId: COMPANY_ID, status: 'INCOMPLETE' },
    });

    const items = mockPrisma.companySubscriptionItem.create.mock.calls.map((c) => c[0].data);
    expect(items).toEqual([
      { companySubscriptionId: 7001, servicePlanId: 8, quantity: 1, unitAmount: '29.00', currency: 'USD' },
      { companySubscriptionId: 7001, servicePlanId: 10, quantity: 12, unitAmount: '15.00', currency: 'USD' },
      { companySubscriptionId: 7001, servicePlanId: 9, quantity: 4, unitAmount: '10.00', currency: 'USD' },
    ]);

    expect(mockPrisma.companySubscription.update).toHaveBeenCalledWith({
      where: { id: 7001 },
      data: { stripeCheckoutSessionId: 'cs_test_123' },
    });
  });

  it('attaches ids and counts to the session metadata, and nothing sensitive', async () => {
    await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', auth())
      .send({
        company_id: COMPANY_ID,
        selected_services: {
          bookkeeping: { selected: true, price_option_id: 'bookkeeping_option_2' },
          payroll: { selected: true, plan_id: 'payroll_standard', employee_count: 12, contractor_count: 4 },
          taxes: { selected: true, price_option_id: 'tax_option_3' },
        },
      });

    const { metadata } = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(metadata).toMatchObject({
      user_id: String(USER_ID),
      company_id: String(COMPANY_ID),
      company_subscription_id: '7001',
      internal_checkout_reference: `chk_${COMPANY_ID}_7001`,
      selected_services: 'bookkeeping,payroll,taxes',
      bookkeeping_price_option_id: 'bookkeeping_option_2',
      bookkeeping_price_id: 'price_book_2',
      payroll_plan_id: 'payroll_standard',
      payroll_base_price_id: 'price_pay_base',
      payroll_employee_price_id: 'price_pay_employee',
      payroll_contractor_price_id: 'price_pay_contractor',
      employee_count: '12',
      contractor_count: '4',
      tax_price_option_id: 'tax_option_3',
      tax_price_id: 'price_tax_3',
    });

    // Every value is a string, as Stripe requires.
    for (const value of Object.values(metadata)) expect(typeof value).toBe('string');

    // No PII and no revenue figures.
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain('accounts@abcaerospace.com');
    expect(serialized).not.toContain('ABC Aerospace');
  });

  it('sets the configured success and cancel URLs', async () => {
    await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    const [args] = mockStripe.checkout.sessions.create.mock.calls[0];
    expect(args.success_url).toBe(config.billing.checkoutSuccessUrl);
    expect(args.success_url).toContain('{CHECKOUT_SESSION_ID}');
    expect(args.cancel_url).toBe(config.billing.checkoutCancelUrl);
  });

  it('hides Stripe ids from the pricing summary when configured to', async () => {
    config.billing.exposeStripeIds = false;

    const res = await request(app).post('/api/billing/checkout').set('Authorization', auth()).send(checkoutBody());

    expect(res.status).toBe(201);
    expect(res.body.data.pricing_summary.bookkeeping).not.toHaveProperty('price_id');
    expect(res.body.data.pricing_summary.bookkeeping).not.toHaveProperty('product_id');
    expect(res.body.data.pricing_summary.bookkeeping.unit_amount).toBe(24900);
  });
});

/* -------------------------------------------------------------------------- */
/* plan catalog                                                                */
/* -------------------------------------------------------------------------- */

describe('GET /billing/plans', () => {
  beforeEach(() => {
    mockPrisma.servicePlan.findMany.mockImplementation(async ({ where }) =>
      (where.planCode?.in ?? []).map((code) => PLANS[code]).filter((p) => p && p.isActive)
    );
  });

  it('publishes four bookkeeping options, three tax options, and the payroll components', async () => {
    const res = await request(app).get('/api/billing/plans').set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.bookkeeping.map((p) => p.option_id)).toEqual([
      'bookkeeping_option_1',
      'bookkeeping_option_2',
      'bookkeeping_option_3',
      'bookkeeping_option_4',
    ]);
    expect(res.body.data.taxes.map((p) => p.option_id)).toEqual([
      'tax_option_1',
      'tax_option_2',
      'tax_option_3',
    ]);
    expect(Object.keys(res.body.data.payroll[0].components).sort()).toEqual([
      'base',
      'contractors',
      'employees',
    ]);
    expect(res.body.data.payroll[0].components.employees.quantity_label).toBe('Number of W-2 Employees');
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/billing/plans');
    expect(res.status).toBe(401);
  });
});
