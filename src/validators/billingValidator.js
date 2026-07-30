'use strict';

const ApiError = require('../utils/ApiError');
const config = require('../config');
const catalog = require('../config/serviceCatalog');

/**
 * Input validation for the service-selection / checkout flow.
 *
 * Same hand-rolled style as companyValidator: unknown fields are REJECTED rather
 * than ignored, every value is normalised once here so the service and Stripe
 * only ever see canonical input, and the function returns a whitelist — the raw
 * request body never travels further than this file.
 *
 * What is deliberately NOT accepted, at any nesting level:
 *   - user_id / owner_user_id      (identity comes from the access token)
 *   - stripe_price_id / price_id   (resolved from an option id, server-side)
 *   - stripe_product_id            (likewise)
 *   - unit_amount / amount / total (computed from the approved Prices)
 *
 * Because `rejectUnknown` runs on every object, a client that sends any of those
 * gets a 400 naming the offending field instead of having it quietly dropped —
 * a dropped field is indistinguishable from an accepted one to whoever is
 * probing the endpoint.
 */

const SERVICE_KEYS = ['bookkeeping', 'payroll', 'taxes'];
const BODY_FIELDS = ['company_id', 'selected_services'];
const BOOKKEEPING_FIELDS = ['selected', 'price_option_id'];
const TAX_FIELDS = ['selected', 'price_option_id'];
const PAYROLL_FIELDS = ['selected', 'plan_id', 'employee_count', 'contractor_count'];

/** Reject any field on `body` that is not in the allowed set (400). */
function rejectUnknown(body, allowed, where) {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new ApiError(400, `Unknown field(s) in ${where}: ${unknown.join(', ')}.`, {
      code: 'VALIDATION_ERROR',
      details: { unknown, where },
    });
  }
}

/** Parse a path param / body id into a positive integer or throw 400. */
function parseId(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError(400, `${field} must be a positive integer.`, { fields: { [field]: 'Invalid id.' } });
  }
  return n;
}

/**
 * `selected` is treated as opt-IN: only an explicit true (or the string "true")
 * selects a service. Anything else — absent, false, null, 0, "yes" — means the
 * service was not chosen, so a malformed flag can never silently add a charge.
 */
function isSelected(value) {
  return value === true || value === 'true';
}

/** A plain, non-array object (the shape every service block must have). */
function requireObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, `${field} must be an object.`, { fields: { [field]: 'Provide an object.' } });
  }
  return value;
}

/**
 * Validate a payroll head-count. Rejects everything that is not a whole,
 * non-negative number within the configured ceiling — decimals ("2.5"),
 * negatives, booleans, arrays, exponent notation, "12abc", Infinity, NaN.
 *
 * Note `Number('')` is 0 and `Number(' 3 ')` is 3, so the raw value is shape-
 * checked with a regex BEFORE conversion; a bare `Number()` would let an empty
 * string through as zero.
 */
function validateCount(value, field, max, code) {
  const invalid = (reason) =>
    new ApiError(400, `${field} must be a whole number between 0 and ${max}.`, {
      code,
      fields: { [field]: reason },
    });

  // Absent means zero: a client that buys payroll without contractors simply
  // omits the field.
  if (value === undefined || value === null) return 0;

  if (typeof value === 'boolean') throw invalid('Enter a whole number.');

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw invalid('Whole numbers only — no decimals.');
  } else if (typeof value === 'string') {
    const raw = value.trim();
    if (!/^\d+$/.test(raw)) {
      throw invalid(raw.includes('.') ? 'Whole numbers only — no decimals.' : 'Enter a whole number.');
    }
  } else {
    throw invalid('Enter a whole number.');
  }

  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw invalid('Enter a whole number of 0 or more.');
  if (n > max) throw invalid(`Must be at most ${max}.`);
  return n;
}

/** Resolve an option id against an allowlist, or throw the caller's error code. */
function validateOptionId(value, field, allowed, code) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, `${field} is required.`, { code, fields: { [field]: 'Select an option.' } });
  }
  const id = value.trim();
  if (!allowed.includes(id)) {
    // The valid ids are not a secret — they are what the catalog endpoint
    // publishes — so echoing them turns a failed integration into a one-line fix.
    throw new ApiError(400, `${field} is not a valid option.`, {
      code,
      fields: { [field]: 'Select one of the available options.' },
      details: { allowed },
    });
  }
  return id;
}

/**
 * Validate POST /billing/checkout.
 *
 * @returns {{
 *   companyId: number,
 *   selections: {
 *     bookkeeping?: { optionId: string },
 *     taxes?: { optionId: string },
 *     payroll?: { planId: string, employeeCount: number, contractorCount: number },
 *   },
 *   selectedServices: string[],
 * }}
 */
function validateCheckoutRequest(body = {}) {
  rejectUnknown(body, BODY_FIELDS, 'request body');

  if (body.company_id === undefined || body.company_id === null || body.company_id === '') {
    throw new ApiError(400, 'company_id is required.', { fields: { company_id: 'Required.' } });
  }
  const companyId = parseId(body.company_id, 'company_id');

  const services = requireObject(body.selected_services ?? {}, 'selected_services');
  rejectUnknown(services, SERVICE_KEYS, 'selected_services');

  const selections = {};
  const selectedServices = [];

  if (services.bookkeeping !== undefined) {
    const block = requireObject(services.bookkeeping, 'selected_services.bookkeeping');
    rejectUnknown(block, BOOKKEEPING_FIELDS, 'selected_services.bookkeeping');
    if (isSelected(block.selected)) {
      selections.bookkeeping = {
        optionId: validateOptionId(
          block.price_option_id,
          'bookkeeping.price_option_id',
          catalog.bookkeepingOptionIds(),
          'INVALID_BOOKKEEPING_PRICE_OPTION'
        ),
      };
      selectedServices.push(catalog.SERVICES.BOOKKEEPING);
    }
  }

  if (services.payroll !== undefined) {
    const block = requireObject(services.payroll, 'selected_services.payroll');
    rejectUnknown(block, PAYROLL_FIELDS, 'selected_services.payroll');
    if (isSelected(block.selected)) {
      const planId = validateOptionId(
        block.plan_id,
        'payroll.plan_id',
        catalog.payrollPlanIds(),
        'INVALID_PAYROLL_PLAN'
      );
      selections.payroll = {
        planId,
        employeeCount: validateCount(
          block.employee_count,
          'payroll.employee_count',
          config.billing.maxEmployeeCount,
          'INVALID_EMPLOYEE_COUNT'
        ),
        contractorCount: validateCount(
          block.contractor_count,
          'payroll.contractor_count',
          config.billing.maxContractorCount,
          'INVALID_CONTRACTOR_COUNT'
        ),
      };
      selectedServices.push(catalog.SERVICES.PAYROLL);
    }
  }

  if (services.taxes !== undefined) {
    const block = requireObject(services.taxes, 'selected_services.taxes');
    rejectUnknown(block, TAX_FIELDS, 'selected_services.taxes');
    if (isSelected(block.selected)) {
      selections.taxes = {
        optionId: validateOptionId(
          block.price_option_id,
          'taxes.price_option_id',
          catalog.taxOptionIds(),
          'INVALID_TAX_PRICE_OPTION'
        ),
      };
      selectedServices.push(catalog.SERVICES.TAXES);
    }
  }

  if (selectedServices.length === 0) {
    throw new ApiError(400, 'Select at least one service to continue.', { code: 'NO_SERVICE_SELECTED' });
  }

  return { companyId, selections, selectedServices };
}

/**
 * Validate the `session_id` query parameter of GET /billing/checkout-status.
 * Stripe Checkout Session ids are `cs_` + an opaque token; the shape check keeps
 * junk out of the Stripe call and out of the logs.
 */
function validateSessionId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, 'session_id is required.', { fields: { session_id: 'Required.' } });
  }
  const id = value.trim();
  if (!/^cs_[A-Za-z0-9_]{4,250}$/.test(id)) {
    throw new ApiError(400, 'session_id is not a valid checkout session id.', {
      code: 'CHECKOUT_SESSION_NOT_FOUND',
      fields: { session_id: 'Invalid session id.' },
    });
  }
  return id;
}

/**
 * `?company_id=` on the read endpoints. Present as a query parameter rather than
 * a path segment to match `?session_id=` on the status endpoint; either way the
 * value is only a lookup key — access is proved against the token, never against
 * what the caller typed here.
 */
function validateCompanyIdQuery(query = {}) {
  const raw = query.company_id;
  if (raw === undefined || raw === null || raw === '') {
    throw new ApiError(400, 'company_id is required.', { fields: { company_id: 'Required.' } });
  }
  return parseId(raw, 'company_id');
}

/** `?limit=&offset=` for payment history, clamped to a sane page size. */
function validatePagination(query = {}) {
  const num = (value, field, fallback, max) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (!/^\d+$/.test(String(value).trim())) {
      throw new ApiError(400, `${field} must be a whole number.`, { fields: { [field]: 'Enter a whole number.' } });
    }
    return Math.min(Number(value), max);
  };
  return {
    limit: Math.max(1, num(query.limit, 'limit', 25, config.billing.maxPageSize)),
    offset: num(query.offset, 'offset', 0, 1_000_000),
  };
}

/**
 * Validate DELETE /billing/subscription.
 *
 * `at_period_end` defaults to TRUE — the customer keeps what they have already
 * paid for until the period they paid for runs out. Immediate cancellation
 * forfeits the remainder, so it has to be asked for explicitly; defaulting the
 * other way would make a mis-click destroy paid time.
 */
function validateCancelRequest(body = {}) {
  rejectUnknown(body, ['company_id', 'at_period_end'], 'request body');

  if (body.company_id === undefined || body.company_id === null || body.company_id === '') {
    throw new ApiError(400, 'company_id is required.', { fields: { company_id: 'Required.' } });
  }

  const raw = body.at_period_end;
  if (raw !== undefined && raw !== null && typeof raw !== 'boolean' && raw !== 'true' && raw !== 'false') {
    throw new ApiError(400, 'at_period_end must be true or false.', {
      fields: { at_period_end: 'Use true or false.' },
    });
  }

  return {
    companyId: parseId(body.company_id, 'company_id'),
    atPeriodEnd: raw === undefined || raw === null ? true : raw === true || raw === 'true',
  };
}

/**
 * Validate PATCH /billing/subscription/payroll.
 *
 * The counts reuse the same validator as checkout, so "12.5 employees" is
 * rejected identically whether it arrives at purchase or at an update. At least
 * one of the two must be present — an empty patch would be a no-op that still
 * cost a Stripe round trip.
 */
function validatePayrollUpdate(body = {}) {
  rejectUnknown(body, ['company_id', 'employee_count', 'contractor_count'], 'request body');

  if (body.company_id === undefined || body.company_id === null || body.company_id === '') {
    throw new ApiError(400, 'company_id is required.', { fields: { company_id: 'Required.' } });
  }
  const companyId = parseId(body.company_id, 'company_id');

  const hasEmployees = body.employee_count !== undefined && body.employee_count !== null;
  const hasContractors = body.contractor_count !== undefined && body.contractor_count !== null;
  if (!hasEmployees && !hasContractors) {
    throw new ApiError(400, 'Provide employee_count, contractor_count, or both.', {
      code: 'VALIDATION_ERROR',
      fields: { employee_count: 'Provide at least one count to change.' },
    });
  }

  return {
    companyId,
    employeeCount: hasEmployees
      ? validateCount(body.employee_count, 'employee_count', config.billing.maxEmployeeCount, 'INVALID_EMPLOYEE_COUNT')
      : null,
    contractorCount: hasContractors
      ? validateCount(body.contractor_count, 'contractor_count', config.billing.maxContractorCount, 'INVALID_CONTRACTOR_COUNT')
      : null,
  };
}

/** Validate POST /billing/portal. */
function validatePortalRequest(body = {}) {
  rejectUnknown(body, ['company_id'], 'request body');
  if (body.company_id === undefined || body.company_id === null || body.company_id === '') {
    throw new ApiError(400, 'company_id is required.', { fields: { company_id: 'Required.' } });
  }
  return { companyId: parseId(body.company_id, 'company_id') };
}

module.exports = {
  validateCheckoutRequest,
  validateSessionId,
  validateCompanyIdQuery,
  validatePagination,
  validateCancelRequest,
  validatePayrollUpdate,
  validatePortalRequest,
  parseId,
  // exported for unit testing
  _internals: { validateCount, validateOptionId, isSelected },
};
