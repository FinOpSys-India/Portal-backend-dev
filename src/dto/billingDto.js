'use strict';

const config = require('../config');
const catalog = require('../config/serviceCatalog');
const money = require('../utils/money');

/**
 * Response DTOs for the billing flow. As with companyDto, these are the ONLY
 * shapes that leave the service, so the contract lives in one place and internal
 * columns never leak by accident.
 *
 * Every money figure is an integer in MINOR units (cents) under a `currency`
 * field — the same units Stripe reports — so the client never has to parse a
 * decimal string or guess a scale.
 *
 * Stripe product and price ids appear only when BILLING_EXPOSE_STRIPE_IDS is on
 * (the default outside production). They are useful while wiring the frontend up
 * and unnecessary afterwards: the client selects by our option ids, so shipping
 * the Stripe ids to every browser only widens what an attacker can see of the
 * billing configuration.
 */

/** The optional Stripe id pair, included per config. */
function stripeIds(line) {
  if (!config.billing.exposeStripeIds) return {};
  return { product_id: line.stripeProductId, price_id: line.stripePriceId };
}

/** One priced line: ids (optionally), quantity, unit price, line total. */
function toLine(line) {
  return {
    ...stripeIds(line),
    option_id: line.optionId,
    quantity: line.quantity,
    unit_amount: line.unitAmountMinor,
    total_amount: line.totalAmountMinor,
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
    // them as an explicit zero so the client can render a stable table.
    for (const component of ['base', 'employees', 'contractors']) {
      if (!payroll[component]) payroll[component] = { quantity: 0, unit_amount: 0, total_amount: 0 };
    }
    payroll.total_amount = payrollLines.reduce((sum, l) => sum + l.totalAmountMinor, 0);
    summary.payroll = payroll;
  }

  const taxes = lines.find((l) => l.service === catalog.SERVICES.TAXES);
  if (taxes) summary.taxes = toLine(taxes);

  summary.grand_total_amount = grandTotalMinor;
  return summary;
}

/** The body returned by POST /billing/checkout. */
function toCheckoutResponse({ session, companyId, selectedServices, pricingSummary }) {
  return {
    checkout_session_id: session.id,
    checkout_url: session.url,
    company_id: companyId,
    selected_services: selectedServices,
    pricing_summary: pricingSummary,
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
      if (entry.component === 'employees') view.employee_count = item.quantity;
      if (entry.component === 'contractors') view.contractor_count = item.quantity;
      view.plan_id = entry.optionId;
    } else {
      view.price_option_id = entry.optionId;
    }
  }

  // A payroll subscription with no contractor line has no contractor item, so
  // report the absent counts as zero rather than leaving the field undefined.
  for (const view of byService.values()) {
    if (view.service === catalog.SERVICES.PAYROLL) {
      view.employee_count ??= 0;
      view.contractor_count ??= 0;
    }
  }

  return [...byService.values()];
}

/** The body returned by GET /billing/checkout-status. */
function toCheckoutStatusResponse({ session, subscription, companyId }) {
  return {
    status: normalizeStatus({ session, subscription }),
    checkout_status: session.status,
    payment_status: session.payment_status ?? null,
    company_id: companyId,
    subscription_status: subscription?.status ?? null,
    current_period_end: subscription?.currentPeriodEnd
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
      const unitAmount = money.decimalToMinor(item.unitAmount, currency);
      return {
        service: entry?.service ?? null,
        component: entry?.component ?? 'plan',
        option_id: entry?.optionId ?? null,
        plan_name: item.servicePlan?.planName ?? null,
        ...(config.billing.exposeStripeIds
          ? {
              product_id: item.servicePlan?.stripeProductId ?? null,
              price_id: item.servicePlan?.stripePriceId ?? null,
            }
          : {}),
        quantity: item.quantity,
        unit_amount: unitAmount,
        total_amount: unitAmount * item.quantity,
        currency,
      };
    })
    // A component dropped to zero keeps its row (history, and the id to re-add
    // it), but it is not something the company is currently paying for.
    .filter((line) => line.quantity > 0);

  const currency = lines[0]?.currency ?? config.billing.supportedCurrency;

  return {
    subscription_id: subscription.id,
    company_id: subscription.companyId,
    status: subscription.status,
    ...(config.billing.exposeStripeIds
      ? { stripe_subscription_id: subscription.stripeSubscriptionId ?? null }
      : {}),
    current_period_start: iso(subscription.currentPeriodStart),
    current_period_end: iso(subscription.currentPeriodEnd),
    cancel_at_period_end: Boolean(subscription.cancelAtPeriodEnd),
    canceled_at: iso(subscription.canceledAt),
    currency,
    recurring_total_amount: lines.reduce((sum, l) => sum + l.total_amount, 0),
    services: toServiceStatuses({ subscription }),
    lines,
  };
}

/** One row of payment history. */
function toPayment(payment) {
  const currency = (payment.currency || '').toUpperCase();
  return {
    payment_id: payment.id,
    amount_paid: money.decimalToMinor(payment.amountPaid, currency),
    currency,
    status: payment.status,
    paid_at: iso(payment.paidAt),
    created_at: iso(payment.createdAt),
    failure_reason: payment.failureReason ?? null,
    ...(config.billing.exposeStripeIds
      ? {
          stripe_invoice_id: payment.stripeInvoiceId ?? null,
          stripe_payment_intent_id: payment.stripePaymentIntentId ?? null,
        }
      : {}),
  };
}

/** A page of payment history plus the cursor the client needs to ask for more. */
function toPaymentsResponse({ payments, total, limit, offset, companyId }) {
  return {
    company_id: companyId,
    payments: payments.map(toPayment),
    pagination: { total, limit, offset, has_more: offset + payments.length < total },
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
