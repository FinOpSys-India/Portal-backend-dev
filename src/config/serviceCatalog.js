'use strict';

/**
 * The service-selection catalog: the ONLY bridge between what the frontend may
 * say and what may reach Stripe.
 *
 * The client sends an option id from this file — `bookkeeping_option_2`,
 * `tax_option_3`, `payroll_standard` — and nothing else about pricing. It never
 * sends a Stripe product id, a Stripe price id, a unit amount, or a total. Each
 * option id maps to a `plan_code`, which is looked up in the `service_plans`
 * table to obtain the Stripe product id, price id, amount, currency, billing
 * interval, and active flag. Anything the client sends that is not a key below is
 * rejected before a single Stripe call is made.
 *
 * Resolution chain, end to end:
 *
 *   option id  ->  plan_code  ->  service_plans row  ->  Stripe Price
 *   (client)      (this file)     (database)            (verified live)
 *
 * WHY THE PLAN CODES LIVE HERE AND THE STRIPE IDS DO NOT
 * ------------------------------------------------------
 * `service_plans` already stores the product/price pair for every plan, and it is
 * seeded from Stripe. Copying those ids into a second list here (or into a dozen
 * environment variables) would create two catalogs that drift the first time a
 * price is rotated in the dashboard — and the one that drifted silently is the
 * one that decides what the customer is charged. So the database stays the single
 * source of truth for ids and amounts, and this file holds only the mapping and
 * the SHAPE of each service (how many options, which parts are quantity-based).
 *
 * OPTIONAL ENVIRONMENT PINS
 * -------------------------
 * Each entry may name a `productEnvVar` / `priceEnvVar`. When that variable is
 * set, the value on the catalog row must equal it or the request is refused with
 * STRIPE_PRODUCT_PRICE_MISMATCH. That gives a locked-down deployment a way to
 * freeze the exact ids it will sell — a change in the database alone can then no
 * longer alter what is charged — without the two-catalogs problem, because the
 * pin only ever *rejects*, it never *supplies*, an id.
 */

/**
 * Service categories, in the order they appear in a checkout summary.
 * These are our own labels; they are also the values echoed back in
 * `selected_services`.
 */
const SERVICES = {
  BOOKKEEPING: 'bookkeeping',
  PAYROLL: 'payroll',
  TAXES: 'taxes',
};

/**
 * Bookkeeping: one product, four selectable prices, quantity always 1.
 * Keys are the option ids the frontend sends as `price_option_id`.
 */
const BOOKKEEPING_OPTIONS = {
  bookkeeping_option_1: { planCode: 'BOOKKEEPING_STARTER', productEnvVar: 'STRIPE_BOOKKEEPING_PRODUCT_ID', priceEnvVar: 'STRIPE_BOOKKEEPING_PRICE_ID_1' },
  bookkeeping_option_2: { planCode: 'BOOKKEEPING_GROWTH', productEnvVar: 'STRIPE_BOOKKEEPING_PRODUCT_ID', priceEnvVar: 'STRIPE_BOOKKEEPING_PRICE_ID_2' },
  bookkeeping_option_3: { planCode: 'BOOKKEEPING_SCALE', productEnvVar: 'STRIPE_BOOKKEEPING_PRODUCT_ID', priceEnvVar: 'STRIPE_BOOKKEEPING_PRICE_ID_3' },
  bookkeeping_option_4: { planCode: 'BOOKKEEPING_PREMIUM', productEnvVar: 'STRIPE_BOOKKEEPING_PRODUCT_ID', priceEnvVar: 'STRIPE_BOOKKEEPING_PRICE_ID_4' },
};

/**
 * Tax: one product, three selectable prices, quantity always 1.
 *
 * The catalog also holds TAX_LEGACY_1499. It is deliberately NOT mapped to an
 * option id: it exists so historical subscriptions keep resolving, but it is not
 * sellable, and an option id is the only way to sell something. To retire it
 * fully, set is_active = false on that row (see the SQL section of the handover).
 */
const TAX_OPTIONS = {
  tax_option_1: { planCode: 'TAX_UNDER_500K', productEnvVar: 'STRIPE_TAX_PRODUCT_ID', priceEnvVar: 'STRIPE_TAX_PRICE_ID_1' },
  tax_option_2: { planCode: 'TAX_500K_TO_2M', productEnvVar: 'STRIPE_TAX_PRODUCT_ID', priceEnvVar: 'STRIPE_TAX_PRICE_ID_2' },
  tax_option_3: { planCode: 'TAX_2M_TO_10M', productEnvVar: 'STRIPE_TAX_PRODUCT_ID', priceEnvVar: 'STRIPE_TAX_PRICE_ID_3' },
};

/**
 * Payroll: one plan id, three component prices.
 *
 * `base` is always billed at quantity 1 whenever payroll is selected. `employees`
 * and `contractors` are per-unit prices whose quantity comes from the validated
 * counts in the request — the ONLY numbers the client contributes to pricing, and
 * they are integers bounded by config.billing.max*Count.
 *
 * Note the seeded catalog puts all three components on ONE Stripe product
 * (prod_TFFu2ZJDKGikWU) rather than three. Validation compares each price against
 * the product recorded on its own row, so one-product and three-product layouts
 * both work; only the env pins below need adjusting if they are ever split.
 */
const PAYROLL_PLANS = {
  payroll_standard: {
    base: {
      planCode: 'PAYROLL_BASE',
      productEnvVar: 'STRIPE_PAYROLL_BASE_PRODUCT_ID',
      priceEnvVar: 'STRIPE_PAYROLL_BASE_PRICE_ID',
    },
    employees: {
      planCode: 'PAYROLL_W2_EMPLOYEE',
      productEnvVar: 'STRIPE_PAYROLL_EMPLOYEE_PRODUCT_ID',
      priceEnvVar: 'STRIPE_PAYROLL_EMPLOYEE_PRICE_ID',
      // Which validated request field supplies this component's quantity.
      quantityField: 'employeeCount',
    },
    contractors: {
      planCode: 'PAYROLL_1099_CONTRACTOR',
      productEnvVar: 'STRIPE_PAYROLL_CONTRACTOR_PRODUCT_ID',
      priceEnvVar: 'STRIPE_PAYROLL_CONTRACTOR_PRICE_ID',
      quantityField: 'contractorCount',
    },
  },
};

/** Every plan_code this file can ever resolve to — used for one batched lookup. */
const ALL_PLAN_CODES = [
  ...Object.values(BOOKKEEPING_OPTIONS).map((o) => o.planCode),
  ...Object.values(TAX_OPTIONS).map((o) => o.planCode),
  ...Object.values(PAYROLL_PLANS).flatMap((p) => Object.values(p).map((c) => c.planCode)),
];

/** Reverse index: plan_code -> { service, optionId, component }. Used by the
 * webhook to turn a Stripe line item back into the selection it came from. */
const BY_PLAN_CODE = new Map();
for (const [optionId, entry] of Object.entries(BOOKKEEPING_OPTIONS)) {
  BY_PLAN_CODE.set(entry.planCode, { service: SERVICES.BOOKKEEPING, optionId, component: 'plan' });
}
for (const [optionId, entry] of Object.entries(TAX_OPTIONS)) {
  BY_PLAN_CODE.set(entry.planCode, { service: SERVICES.TAXES, optionId, component: 'plan' });
}
for (const [planId, components] of Object.entries(PAYROLL_PLANS)) {
  for (const [component, entry] of Object.entries(components)) {
    BY_PLAN_CODE.set(entry.planCode, { service: SERVICES.PAYROLL, optionId: planId, component });
  }
}

/** The bookkeeping option ids a client may send. */
function bookkeepingOptionIds() {
  return Object.keys(BOOKKEEPING_OPTIONS);
}

/** The tax option ids a client may send. */
function taxOptionIds() {
  return Object.keys(TAX_OPTIONS);
}

/** The payroll plan ids a client may send. */
function payrollPlanIds() {
  return Object.keys(PAYROLL_PLANS);
}

module.exports = {
  SERVICES,
  BOOKKEEPING_OPTIONS,
  TAX_OPTIONS,
  PAYROLL_PLANS,
  ALL_PLAN_CODES,
  BY_PLAN_CODE,
  bookkeepingOptionIds,
  taxOptionIds,
  payrollPlanIds,
};
