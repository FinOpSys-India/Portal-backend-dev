'use strict';

const config = require('../config');
const { prisma } = require('../config/prisma');
const catalog = require('../config/serviceCatalog');
const { getStripe } = require('../config/stripe');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const money = require('../utils/money');
const repo = require('../repositories/billingRepository');

/**
 * Resolution and validation of the service selection into approved Stripe line
 * items. This module is the security boundary of the whole billing flow: it is
 * the only place that turns a client-supplied option id into a Stripe price id,
 * and nothing downstream of it accepts an id from any other source.
 *
 * For every component of every selected service it establishes, in order:
 *
 *   1. the option id is one this backend sells               (serviceCatalog)
 *   2. a catalog row exists for its plan_code and is ACTIVE  (service_plans)
 *   3. the row's ids match the environment pins, if pinned   (config)
 *   4. the Price exists in Stripe and is active              (live API)
 *   5. the Price belongs to the EXPECTED Product             (live API)
 *   6. the currency is the one supported                     (live API)
 *   7. the billing interval matches the catalog row          (live API)
 *   8. the Price type is compatible with the Checkout mode   (live API)
 *
 * Only then does the price id become a line item. A failure at any step is an
 * ApiError with the documented code, raised before any Stripe Checkout Session
 * exists — so a rejected request leaves nothing behind to clean up.
 */

/* --------------------------------- errors -------------------------------- */

function priceNotFound(planCode) {
  return new ApiError(422, 'This plan is not available for purchase right now.', {
    code: 'STRIPE_PRICE_NOT_FOUND',
    details: { planCode },
  });
}
function priceInactive(planCode) {
  return new ApiError(422, 'This plan is no longer available for purchase.', {
    code: 'STRIPE_PRICE_INACTIVE',
    details: { planCode },
  });
}
function productMismatch(planCode) {
  return new ApiError(422, 'This plan is misconfigured and cannot be purchased.', {
    code: 'STRIPE_PRODUCT_PRICE_MISMATCH',
    details: { planCode },
  });
}
function currencyMismatch(planCode) {
  return new ApiError(422, 'This plan is priced in an unsupported currency.', {
    code: 'STRIPE_PRICE_CURRENCY_MISMATCH',
    details: { planCode },
  });
}
function intervalMismatch(planCode) {
  return new ApiError(422, 'This plan has an unexpected billing period.', {
    code: 'STRIPE_PRICE_INTERVAL_MISMATCH',
    details: { planCode },
  });
}

/* ------------------------- live Price verification ------------------------ */

/*
 * A checkout can touch five prices, and a user who clicks twice doubles that.
 * Verified Price objects are therefore memoised briefly. The TTL is short on
 * purpose: the whole point of verifying live is to notice a price that was
 * deactivated or re-pointed in the dashboard, and a long cache would defeat it.
 */
const priceCache = new Map();

function cacheGet(priceId) {
  const hit = priceCache.get(priceId);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    priceCache.delete(priceId);
    return null;
  }
  return hit.price;
}

function cacheSet(priceId, price) {
  priceCache.set(priceId, {
    price,
    expiresAt: Date.now() + config.stripe.priceCacheTtlSeconds * 1000,
  });
}

/** Drop the memoised Price objects. Test seam, and useful after a price rotation. */
function clearPriceCache() {
  priceCache.clear();
}

/**
 * `price.product` is a bare id string on a normal retrieve, but an expanded
 * Product object when the caller (or a future change here) asks for it, and a
 * DeletedProduct object when the product has been removed. Reduce all three to
 * the id; a deleted product yields the id but fails the `active` check below.
 */
function productIdOf(price) {
  const product = price?.product;
  if (!product) return null;
  return typeof product === 'string' ? product : product.id ?? null;
}

/** Read a Price from Stripe, translating "no such price" into our 422. */
async function retrievePrice(priceId, planCode) {
  const cached = cacheGet(priceId);
  if (cached) return cached;

  const stripe = getStripe();
  let price;
  try {
    price = await stripe.prices.retrieve(priceId);
  } catch (err) {
    if (err?.statusCode === 404 || err?.code === 'resource_missing') {
      logger.error(`Stripe price ${priceId} (plan ${planCode}) does not exist.`);
      throw priceNotFound(planCode);
    }
    throw err;
  }
  cacheSet(priceId, price);
  return price;
}

/* -------------------------- resolution + checks --------------------------- */

/**
 * Build the ordered list of components the selection implies, before any
 * database or Stripe access. Zero-quantity payroll components are dropped here:
 * Stripe rejects a subscription line item with quantity 0, and a customer with
 * no contractors should not see a $0 contractor line on the invoice.
 */
function planComponentsFor(selections) {
  const wanted = [];

  if (selections.bookkeeping) {
    const entry = catalog.BOOKKEEPING_OPTIONS[selections.bookkeeping.optionId];
    wanted.push({
      service: catalog.SERVICES.BOOKKEEPING,
      component: 'plan',
      optionId: selections.bookkeeping.optionId,
      quantity: 1,
      ...entry,
    });
  }

  if (selections.payroll) {
    const plan = catalog.PAYROLL_PLANS[selections.payroll.planId];
    // Base first, then the per-unit components, so the invoice reads in the
    // same order as the pricing summary.
    for (const [component, entry] of Object.entries(plan)) {
      const quantity = entry.quantityField ? selections.payroll[entry.quantityField] : 1;
      if (quantity <= 0) continue;
      wanted.push({
        service: catalog.SERVICES.PAYROLL,
        component,
        optionId: selections.payroll.planId,
        quantity,
        ...entry,
      });
    }
  }

  if (selections.taxes) {
    const entry = catalog.TAX_OPTIONS[selections.taxes.optionId];
    wanted.push({
      service: catalog.SERVICES.TAXES,
      component: 'plan',
      optionId: selections.taxes.optionId,
      quantity: 1,
      ...entry,
    });
  }

  return wanted;
}

/**
 * Enforce the optional environment pins. When STRIPE_..._PRODUCT_ID or
 * STRIPE_..._PRICE_ID is set, the catalog row must match it exactly. The pin can
 * only ever reject — it never supplies an id — so the database stays the single
 * source of truth while the environment gets a veto.
 */
function assertEnvironmentPins(want, plan) {
  const pinnedProduct = want.productEnvVar ? process.env[want.productEnvVar] : undefined;
  if (pinnedProduct && pinnedProduct !== plan.stripeProductId) {
    logger.error(
      `Plan ${plan.planCode}: stripe_product_id ${plan.stripeProductId} does not match ${want.productEnvVar}.`
    );
    throw productMismatch(plan.planCode);
  }

  const pinnedPrice = want.priceEnvVar ? process.env[want.priceEnvVar] : undefined;
  if (pinnedPrice && pinnedPrice !== plan.stripePriceId) {
    logger.error(
      `Plan ${plan.planCode}: stripe_price_id ${plan.stripePriceId} does not match ${want.priceEnvVar}.`
    );
    throw productMismatch(plan.planCode);
  }
}

/**
 * Verify one Price against Stripe and return the authoritative unit amount.
 *
 * The expected product id is the one on the catalog row — the same row the price
 * id came from — so this genuinely proves the pair belongs together in Stripe,
 * not merely that our two columns agree with each other.
 *
 * When live verification is disabled (test, or STRIPE_VERIFY_PRICES=false) the
 * catalog row's cached amount is used instead. That is a display cache, not the
 * truth, which is why the default is to verify.
 */
async function verifyAgainstStripe(plan) {
  if (!config.stripe.verifyPricesWithApi) {
    return {
      unitAmountMinor: money.decimalToMinor(plan.amount, plan.currency),
      currency: plan.currency.toUpperCase(),
      recurring: true,
      interval: plan.billingInterval,
      verified: false,
    };
  }

  const price = await retrievePrice(plan.stripePriceId, plan.planCode);

  if (!price.active) throw priceInactive(plan.planCode);

  const stripeProductId = productIdOf(price);
  if (!stripeProductId || stripeProductId !== plan.stripeProductId) {
    logger.error(
      `Stripe price ${plan.stripePriceId} belongs to product ${stripeProductId}, expected ${plan.stripeProductId}.`
    );
    throw productMismatch(plan.planCode);
  }

  const currency = String(price.currency || '').toUpperCase();
  if (currency !== config.billing.supportedCurrency || currency !== plan.currency.toUpperCase()) {
    throw currencyMismatch(plan.planCode);
  }

  const recurring = Boolean(price.recurring);
  if (recurring) {
    // Stripe reports 'month' / 'year'; the catalog stores MONTH / YEAR.
    if (String(price.recurring.interval).toUpperCase() !== plan.billingInterval) {
      throw intervalMismatch(plan.planCode);
    }
    // interval_count > 1 ("every 3 months") would silently change the renewal
    // cadence of a session assembled from several plans. Refuse it here rather
    // than discover it on the first invoice.
    if ((price.recurring.interval_count ?? 1) !== 1) {
      throw intervalMismatch(plan.planCode);
    }
  }

  // A tiered or metered price has no flat unit_amount, so there is nothing to
  // total server-side and the pricing summary would be a guess.
  if (price.unit_amount === null || price.unit_amount === undefined) {
    logger.error(`Stripe price ${plan.stripePriceId} has no flat unit_amount (tiered or metered).`);
    throw new ApiError(422, 'This plan cannot be purchased through this flow.', {
      code: 'INCOMPATIBLE_CHECKOUT_PRICES',
      details: { planCode: plan.planCode },
    });
  }

  return {
    unitAmountMinor: price.unit_amount,
    currency,
    recurring,
    interval: recurring ? String(price.recurring.interval).toUpperCase() : null,
    verified: true,
  };
}

/**
 * Resolve a validated selection into approved, priced line items.
 *
 * @param {object} selections  Output of billingValidator.validateCheckoutRequest.
 * @param {object} [client]    Prisma client; defaults to the shared one.
 * @returns {Promise<{ lines: object[], mode: 'subscription'|'payment', currency: string, grandTotalMinor: number }>}
 */
async function resolveSelection(selections, client = prisma) {
  const wanted = planComponentsFor(selections);

  // One query for every plan the selection needs. Inactive rows are excluded by
  // the query itself, so "missing" and "deactivated" collapse into one branch.
  const planCodes = [...new Set(wanted.map((w) => w.planCode))];
  const rows = await repo.findActivePlansByCodes(client, planCodes);
  const byCode = new Map(rows.map((r) => [r.planCode, r]));

  const lines = [];
  for (const want of wanted) {
    const plan = byCode.get(want.planCode);
    if (!plan) {
      logger.error(`Plan ${want.planCode} (option ${want.optionId}) is missing or inactive in service_plans.`);
      throw priceNotFound(want.planCode);
    }

    assertEnvironmentPins(want, plan);

    const verified = await verifyAgainstStripe(plan);
    const totalMinor = money.multiply(verified.unitAmountMinor, want.quantity);

    lines.push({
      service: want.service,
      component: want.component,
      optionId: want.optionId,
      planCode: plan.planCode,
      planName: plan.planName,
      servicePlanId: plan.id,
      stripeProductId: plan.stripeProductId,
      stripePriceId: plan.stripePriceId,
      quantity: want.quantity,
      unitAmountMinor: verified.unitAmountMinor,
      totalAmountMinor: totalMinor,
      currency: verified.currency,
      recurring: verified.recurring,
      interval: verified.interval,
      verified: verified.verified,
    });
  }

  const { mode, currency } = assertCompatible(lines);
  const grandTotalMinor = lines.reduce((sum, l) => sum + l.totalAmountMinor, 0);

  return { lines, mode, currency, grandTotalMinor };
}

/**
 * Decide the Checkout mode and refuse combinations Stripe cannot bill as one
 * session.
 *
 * Stripe will not put a one-time price and a recurring price in the same
 * Checkout Session, nor two recurring prices on different intervals. Both are
 * silent-failure shapes if you let them through: the customer either sees an
 * opaque Stripe error at the redirect, or ends up on a cadence nobody chose. So
 * the incompatibility is detected here, named, and returned as
 * INCOMPATIBLE_CHECKOUT_PRICES with the offending services listed.
 *
 * All eleven seeded plans are monthly recurring, so today every combination
 * resolves to `subscription`. If tax is ever repriced as a one-time fee, this
 * function is what will tell you — and the safe flow then is TWO sessions (one
 * subscription, one payment), not one mixed session. That is a product decision,
 * not something to paper over automatically, and nothing here changes a Stripe
 * Price to force a fit.
 */
function assertCompatible(lines) {
  const currencies = [...new Set(lines.map((l) => l.currency))];
  if (currencies.length > 1) {
    throw new ApiError(422, 'The selected services are priced in different currencies.', {
      code: 'STRIPE_PRICE_CURRENCY_MISMATCH',
      details: { currencies },
    });
  }

  const recurring = lines.filter((l) => l.recurring);
  const oneTime = lines.filter((l) => !l.recurring);

  if (recurring.length && oneTime.length) {
    throw new ApiError(422, 'The selected services cannot be purchased together.', {
      code: 'INCOMPATIBLE_CHECKOUT_PRICES',
      details: {
        reason: 'mixed_recurring_and_one_time',
        recurringServices: [...new Set(recurring.map((l) => l.service))],
        oneTimeServices: [...new Set(oneTime.map((l) => l.service))],
      },
    });
  }

  if (recurring.length) {
    const intervals = [...new Set(recurring.map((l) => l.interval))];
    if (intervals.length > 1) {
      throw new ApiError(422, 'The selected services renew on different schedules.', {
        code: 'INCOMPATIBLE_CHECKOUT_PRICES',
        details: { reason: 'mixed_intervals', intervals },
      });
    }
  }

  return { mode: recurring.length ? 'subscription' : 'payment', currency: currencies[0] };
}

/**
 * The sellable catalog, as the frontend needs it: our option ids, names, and
 * amounts — and no Stripe ids unless BILLING_EXPOSE_STRIPE_IDS says otherwise.
 * This is what lets the client render the four bookkeeping tiers and the three
 * tax tiers without ever learning a price id.
 */
async function listCatalog(client = prisma) {
  const rows = await repo.listActivePlans(client, catalog.ALL_PLAN_CODES);
  const byCode = new Map(rows.map((r) => [r.planCode, r]));

  const view = (optionId, entry, extra = {}) => {
    const plan = byCode.get(entry.planCode);
    if (!plan) return null;
    return {
      optionId,
      name: plan.planName,
      unitAmountMinor: money.decimalToMinor(plan.amount, plan.currency),
      currency: plan.currency.toUpperCase(),
      billingInterval: plan.billingInterval,
      displayOrder: plan.displayOrder ?? 0,
      // `quantityLabel` is the wording the client puts next to a counter, so it
      // is present only for the lines that are actually billed per unit.
      quantityEnabled: Boolean(plan.quantityEnabled),
      ...(plan.quantityEnabled ? { quantityLabel: plan.quantityLabel } : {}),
      ...(config.billing.exposeStripeIds
        ? { stripe: { productId: plan.stripeProductId, priceId: plan.stripePriceId } }
        : {}),
      ...extra,
    };
  };

  const byOrder = (a, b) => a.displayOrder - b.displayOrder;

  const bookkeeping = Object.entries(catalog.BOOKKEEPING_OPTIONS)
    .map(([id, e]) => view(id, e))
    .filter(Boolean)
    .sort(byOrder);

  const taxes = Object.entries(catalog.TAX_OPTIONS)
    .map(([id, e]) => view(id, e))
    .filter(Boolean)
    .sort(byOrder);

  const payroll = Object.entries(catalog.PAYROLL_PLANS)
    .map(([planId, components]) => {
      const parts = {};
      for (const [component, entry] of Object.entries(components)) {
        const rendered = view(planId, entry, { component });
        if (rendered) parts[component] = rendered;
      }
      return Object.keys(parts).length ? { planId, components: parts } : null;
    })
    .filter(Boolean);

  return { currency: config.billing.supportedCurrency, bookkeeping, payroll, taxes };
}

module.exports = {
  resolveSelection,
  listCatalog,
  clearPriceCache,
  // exported for unit testing
  _internals: { planComponentsFor, assertCompatible, productIdOf, verifyAgainstStripe },
};
