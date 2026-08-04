'use strict';

const config = require('../config');
const catalog = require('../config/serviceCatalog');
const money = require('../utils/money');

/**
 * Response DTOs for the billing flow. As with companyDto, these are the ONLY
 * shapes that leave the service, so the contract lives in one place and internal
 * columns never leak by accident.
 *
 * Keys are camelCase throughout, matching every other module.
 *
 * Every money figure is an integer in MINOR units (cents) under a `currency`
 * field — the same units Stripe reports — so the client never has to parse a
 * decimal string or guess a scale. The field is named `...AmountMinor` rather
 * than `...Amount`: the unit is part of the meaning, and a bare `unitAmount` of
 * 24900 is exactly the shape of value someone renders as "$24,900".
 *
 * Stripe product and price ids appear only when BILLING_EXPOSE_STRIPE_IDS is on
 * (the default outside production). They are useful while wiring the frontend up
 * and unnecessary afterwards: the client selects by our option ids, so shipping
 * the Stripe ids to every browser only widens what an attacker can see of the
 * billing configuration. Because they vanish in production, a client must never
 * depend on them — which is why they are grouped under a single `stripe` key
 * that is either present in full or absent in full, rather than sprinkled as
 * sibling fields that disappear one by one.
 */

/** The optional Stripe id pair, included per config. */
function stripeIds(line) {
  if (!config.billing.exposeStripeIds) return {};
  return { stripe: { productId: line.stripeProductId, priceId: line.stripePriceId } };
}

/** One priced line: ids (optionally), quantity, unit price, line total. */
function toLine(line) {
  return {
    optionId: line.optionId,
    quantity: line.quantity,
    unitAmountMinor: line.unitAmountMinor,
    totalAmountMinor: line.totalAmountMinor,
    ...stripeIds(line),
  };
}

/**
 * The backend-calculated pricing summary, grouped by service. Payroll is nested
 * (`base` / `employees` / `contractors` + a payroll subtotal) because that is
 * the breakdown the customer is shown before they are redirected:
 *
 *   payroll total = base + (employees x unit) + (contractors x unit)
 *
 * Every figure here comes from the approved Stripe Prices resolved server-side.
 * No amount in this object ever originated in the request body.
 */
function toPricingSummary({ lines, currency, grandTotalMinor }) {
  const summary = { currency };

  const bookkeeping = lines.find((l) => l.service === catalog.SERVICES.BOOKKEEPING);
  if (bookkeeping) summary.bookkeeping = toLine(bookkeeping);

  const payrollLines = lines.filter((l) => l.service === catalog.SERVICES.PAYROLL);
  if (payrollLines.length) {
    const payroll = {};
    for (const line of payrollLines) payroll[line.component] = toLine(line);
    // Components with a zero count are dropped before they reach Stripe; report
    // them as an explicit zero so the client can render a stable table. The
    // optionId is carried through so the row is still identifiable when empty.
    const planId = payrollLines[0]?.optionId ?? null;
    for (const component of ['base', 'employees', 'contractors']) {
      if (!payroll[component]) {
        payroll[component] = {
          optionId: planId,
          quantity: 0,
          unitAmountMinor: 0,
          totalAmountMinor: 0,
        };
      }
    }
    payroll.totalAmountMinor = payrollLines.reduce((sum, l) => sum + l.totalAmountMinor, 0);
    summary.payroll = payroll;
  }

  const taxes = lines.find((l) => l.service === catalog.SERVICES.TAXES);
  if (taxes) summary.taxes = toLine(taxes);

  summary.grandTotalAmountMinor = grandTotalMinor;
  return summary;
}

/** The body returned by POST /billing/checkout. */
function toCheckoutResponse({ session, companyId, selectedServices, pricingSummary }) {
  return {
    checkoutSessionId: session.id,
    checkoutUrl: session.url,
    companyId,
    selectedServices,
    pricingSummary,
  };
}

/**
 * Collapse Stripe's two status fields (plus our own subscription row) into one
 * value the frontend can switch on.
 *
 *   paid        payment settled — the subscription is live
 *   processing  session complete but the money has not landed yet
 *               (async methods, e.g. bank debits, sit here for days)
 *   pending     session still open; the customer has not finished paying
 *   cancelled   session expired or was abandoned
 *   failed      the payment or the subscription went bad
 *
 * `processing` exists so the success page never claims success on an
 * asynchronous payment method that can still fail.
 */
function normalizeStatus({ session, subscription }) {
  if (subscription && ['PAST_DUE', 'UNPAID'].includes(subscription.status)) return 'failed';
  if (subscription && subscription.status === 'CANCELED') return 'cancelled';

  if (session.status === 'expired') return 'cancelled';
  if (session.status === 'open') return 'pending';

  if (session.status === 'complete') {
    if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
      return 'paid';
    }
    return 'processing';
  }
  return 'pending';
}

/**
 * Per-service activation view for the status endpoint, rebuilt from OUR
 * subscription items rather than from the session — the items are what the
 * webhook validated and wrote, so this reports what was actually provisioned.
 */
function toServiceStatuses({ subscription }) {
  if (!subscription?.items?.length) return [];

  const active = subscription.status === 'ACTIVE';
  const byService = new Map();

  for (const item of subscription.items) {
    const planCode = item.servicePlan?.planCode;
    const entry = planCode ? catalog.BY_PLAN_CODE.get(planCode) : null;
    if (!entry) continue;

    if (!byService.has(entry.service)) {
      byService.set(entry.service, {
        service: entry.service,
        status: active ? 'active' : 'inactive',
      });
    }
    const view = byService.get(entry.service);

    if (entry.service === catalog.SERVICES.PAYROLL) {
      if (entry.component === 'employees') view.employeeCount = item.quantity;
      if (entry.component === 'contractors') view.contractorCount = item.quantity;
      view.planId = entry.optionId;
    } else {
      view.priceOptionId = entry.optionId;
    }
  }

  // A payroll subscription with no contractor line has no contractor item, so
  // report the absent counts as zero rather than leaving the field undefined.
  for (const view of byService.values()) {
    if (view.service === catalog.SERVICES.PAYROLL) {
      view.employeeCount ??= 0;
      view.contractorCount ??= 0;
    }
  }

  return [...byService.values()];
}

/** The body returned by GET /billing/checkout-status. */
function toCheckoutStatusResponse({ session, subscription, companyId }) {
  return {
    status: normalizeStatus({ session, subscription }),
    checkoutStatus: session.status,
    paymentStatus: session.payment_status ?? null,
    companyId,
    subscriptionStatus: subscription?.status ?? null,
    currentPeriodEnd: subscription?.currentPeriodEnd
      ? new Date(subscription.currentPeriodEnd).toISOString()
      : null,
    services: toServiceStatuses({ subscription }),
  };
}

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * The company's current subscription: what it is paying for, what it renews to,
 * and what each line costs.
 *
 * Amounts come from `company_subscription_items.unit_amount` — the price captured
 * at purchase — NOT from the live plan catalog. That is the whole point of
 * duplicating the column: a subscriber who bought at $249 must keep reading $249
 * after the list price moves, or the page contradicts their invoice.
 */
function toSubscriptionResponse({ subscription }) {
  if (!subscription) return null;

  const lines = (subscription.items ?? [])
    .map((item) => {
      const planCode = item.servicePlan?.planCode;
      const entry = planCode ? catalog.BY_PLAN_CODE.get(planCode) : null;
      const currency = (item.currency || '').toUpperCase();
      const unitAmountMinor = money.decimalToMinor(item.unitAmount, currency);
      return {
        service: entry?.service ?? null,
        component: entry?.component ?? 'plan',
        optionId: entry?.optionId ?? null,
        planName: item.servicePlan?.planName ?? null,
        quantity: item.quantity,
        unitAmountMinor,
        totalAmountMinor: unitAmountMinor * item.quantity,
        currency,
        ...(config.billing.exposeStripeIds
          ? {
              stripe: {
                productId: item.servicePlan?.stripeProductId ?? null,
                priceId: item.servicePlan?.stripePriceId ?? null,
                subscriptionItemId: item.stripeSubscriptionItemId ?? null,
              },
            }
          : {}),
      };
    })
    // A component dropped to zero keeps its row (history, and the id to re-add
    // it), but it is not something the company is currently paying for.
    .filter((line) => line.quantity > 0);

  const currency = lines[0]?.currency ?? config.billing.supportedCurrency;

  return {
    subscriptionId: subscription.id,
    companyId: subscription.companyId,
    status: subscription.status,
    currentPeriodStart: iso(subscription.currentPeriodStart),
    currentPeriodEnd: iso(subscription.currentPeriodEnd),
    cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
    canceledAt: iso(subscription.canceledAt),
    currency,
    recurringTotalAmountMinor: lines.reduce((sum, l) => sum + l.totalAmountMinor, 0),
    services: toServiceStatuses({ subscription }),
    lines,
    ...(config.billing.exposeStripeIds
      ? {
          stripe: {
            subscriptionId: subscription.stripeSubscriptionId ?? null,
            checkoutSessionId: subscription.stripeCheckoutSessionId ?? null,
          },
        }
      : {}),
  };
}

/** One row of payment history. */
function toPayment(payment) {
  const currency = (payment.currency || '').toUpperCase();
  return {
    paymentId: payment.id,
    amountPaidMinor: money.decimalToMinor(payment.amountPaid, currency),
    amountRefundedMinor: payment.amountRefunded
      ? money.decimalToMinor(payment.amountRefunded, currency)
      : 0,
    currency,
    status: payment.status,
    paidAt: iso(payment.paidAt),
    refundedAt: iso(payment.refundedAt),
    createdAt: iso(payment.createdAt),
    failureReason: payment.failureReason ?? null,
    ...(config.billing.exposeStripeIds
      ? {
          stripe: {
            invoiceId: payment.stripeInvoiceId ?? null,
            paymentIntentId: payment.stripePaymentIntentId ?? null,
          },
        }
      : {}),
  };
}

/** A page of payment history plus the cursor the client needs to ask for more. */
function toPaymentsResponse({ payments, total, limit, offset, companyId, sort, order }) {
  return {
    companyId,
    payments: payments.map(toPayment),
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + payments.length < total,
      ...(sort ? { sort, order } : {}),
    },
  };
}

module.exports = {
  toPricingSummary,
  toCheckoutResponse,
  toCheckoutStatusResponse,
  toSubscriptionResponse,
  toPaymentsResponse,
  toPayment,
  toServiceStatuses,
  normalizeStatus,
};
