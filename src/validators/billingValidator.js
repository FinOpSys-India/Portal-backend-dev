'use strict';

const ApiError = require('../utils/ApiError');
const config = require('../config');
const catalog = require('../config/serviceCatalog');
const common = require('./common');

/**
 * Input validation for the service-selection / checkout flow.
 *
 * Canonical field names are camelCase; snake_case requests are normalised before
 * this file runs (middlewares/normalizeRequest), so `company_id` and `companyId`
 * are both accepted and there is still exactly one name to validate.
 *
 * Unknown fields are REJECTED rather than ignored, every value is normalised once
 * here so the service and Stripe only ever see canonical input, and the function
 * returns a whitelist — the raw request body never travels further than this file.
 *
 * What is deliberately NOT accepted, at any nesting level:
 *   - userId / ownerUserId          (identity comes from the access token)
 *   - stripePriceId / priceId       (resolved from an option id, server-side)
 *   - stripeProductId               (likewise)
 *   - unitAmount / amount / total   (computed from the approved Prices)
 *
 * Because `rejectUnknown` runs on every object, a client that sends any of those
 * gets a 400 naming the offending field instead of having it quietly dropped — a
 * dropped field is indistinguishable from an accepted one to whoever is probing
 * the endpoint.
 */

const SERVICE_KEYS = ['bookkeeping', 'payroll', 'taxes'];
const BODY_FIELDS = ['companyId', 'selectedServices'];
const BOOKKEEPING_FIELDS = ['selected', 'priceOptionId'];
const TAX_FIELDS = ['selected', 'priceOptionId'];
const PAYROLL_FIELDS = ['selected', 'planId', 'employeeCount', 'contractorCount'];

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
    throw common.fieldError(field, `${field} must be an object.`, 'Provide an object.');
  }
  return value;
}

/**
 * Validate a payroll head-count. Rejects everything that is not a whole,
 * non-negative number within the configured ceiling — decimals ("2.5"),
 * negatives, booleans, arrays, exponent notation, "12abc", Infinity, NaN.
 *
 * Absent means zero: a client that buys payroll without contractors simply omits
 * the field.
 */
function validateCount(value, field, max, code) {
  if (value === undefined || value === null) return 0;
  return common.integer(value, field, { min: 0, max, code });
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
 * Parse the `selectedServices` block shared by checkout and the add-services
 * flow. Extracted so a service added to a live subscription is validated by
 * exactly the same rules that governed the original purchase — two code paths
 * would eventually disagree about what a valid selection is.
 *
 * @returns {{ selections: object, selectedServices: string[] }}
 */
function parseSelectedServices(rawServices) {
  const services = requireObject(rawServices ?? {}, 'selectedServices');
  common.rejectUnknown(services, SERVICE_KEYS, 'selectedServices');

  const selections = {};
  const selectedServices = [];

  if (services.bookkeeping !== undefined) {
    const block = requireObject(services.bookkeeping, 'selectedServices.bookkeeping');
    common.rejectUnknown(block, BOOKKEEPING_FIELDS, 'selectedServices.bookkeeping');
    if (isSelected(block.selected)) {
      selections.bookkeeping = {
        optionId: validateOptionId(
          block.priceOptionId,
          'bookkeeping.priceOptionId',
          catalog.bookkeepingOptionIds(),
          'INVALID_BOOKKEEPING_PRICE_OPTION'
        ),
      };
      selectedServices.push(catalog.SERVICES.BOOKKEEPING);
    }
  }

  if (services.payroll !== undefined) {
    const block = requireObject(services.payroll, 'selectedServices.payroll');
    common.rejectUnknown(block, PAYROLL_FIELDS, 'selectedServices.payroll');
    if (isSelected(block.selected)) {
      const planId = validateOptionId(
        block.planId,
        'payroll.planId',
        catalog.payrollPlanIds(),
        'INVALID_PAYROLL_PLAN'
      );
      selections.payroll = {
        planId,
        employeeCount: validateCount(
          block.employeeCount,
          'payroll.employeeCount',
          config.billing.maxEmployeeCount,
          'INVALID_EMPLOYEE_COUNT'
        ),
        contractorCount: validateCount(
          block.contractorCount,
          'payroll.contractorCount',
          config.billing.maxContractorCount,
          'INVALID_CONTRACTOR_COUNT'
        ),
      };
      selectedServices.push(catalog.SERVICES.PAYROLL);
    }
  }

  if (services.taxes !== undefined) {
    const block = requireObject(services.taxes, 'selectedServices.taxes');
    common.rejectUnknown(block, TAX_FIELDS, 'selectedServices.taxes');
    if (isSelected(block.selected)) {
      selections.taxes = {
        optionId: validateOptionId(
          block.priceOptionId,
          'taxes.priceOptionId',
          catalog.taxOptionIds(),
          'INVALID_TAX_PRICE_OPTION'
        ),
      };
      selectedServices.push(catalog.SERVICES.TAXES);
    }
  }

  return { selections, selectedServices };
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
  common.rejectUnknown(body, BODY_FIELDS);
  common.requireFields(body, ['companyId']);

  const companyId = common.parseId(body.companyId, 'companyId');
  const { selections, selectedServices } = parseSelectedServices(body.selectedServices);

  if (selectedServices.length === 0) {
    throw new ApiError(400, 'Select at least one service to continue.', { code: 'NO_SERVICE_SELECTED' });
  }

  return { companyId, selections, selectedServices };
}

/**
 * Validate POST /billing/subscription/services — adding a service to a live
 * subscription. Same selection grammar as checkout; the service layer refuses
 * anything the company already pays for.
 */
function validateAddServicesRequest(body = {}) {
  common.rejectUnknown(body, BODY_FIELDS);
  common.requireFields(body, ['companyId']);

  const companyId = common.parseId(body.companyId, 'companyId');
  const { selections, selectedServices } = parseSelectedServices(body.selectedServices);

  if (selectedServices.length === 0) {
    throw new ApiError(400, 'Select at least one service to add.', { code: 'NO_SERVICE_SELECTED' });
  }

  return { companyId, selections, selectedServices };
}

/**
 * Validate the `sessionId` query parameter of GET /billing/checkout-status.
 * Stripe Checkout Session ids are `cs_` + an opaque token; the shape check keeps
 * junk out of the Stripe call and out of the logs.
 */
function validateSessionId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw common.fieldError('sessionId', 'sessionId is required.', 'Required.');
  }
  const id = value.trim();
  if (!/^cs_[A-Za-z0-9_]{4,250}$/.test(id)) {
    // 400 with a VALIDATION_ERROR code: the value is malformed, which is a
    // different condition from a well-formed id that names no session (404
    // CHECKOUT_SESSION_NOT_FOUND). Sharing one code across both statuses forced
    // clients to branch on status anyway.
    throw common.fieldError('sessionId', 'sessionId is not a valid checkout session id.', 'Invalid session id.');
  }
  return id;
}

/**
 * `?companyId=` on the read endpoints. Present as a query parameter rather than
 * a path segment to match `?sessionId=` on the status endpoint; either way the
 * value is only a lookup key — access is proved against the token, never against
 * what the caller typed here.
 */
function validateCompanyIdQuery(query = {}) {
  const raw = query.companyId;
  if (raw === undefined || raw === null || raw === '') {
    throw common.fieldError('companyId', 'companyId is required.', 'Required.');
  }
  return common.parseId(raw, 'companyId');
}

/** `?limit=&offset=&sort=&order=&status=` for payment history. */
const PAYMENT_SORTABLE = ['paidAt', 'createdAt', 'amountPaid', 'status'];

function validatePaymentsQuery(query = {}) {
  common.rejectUnknown(query, ['companyId', 'limit', 'offset', 'sort', 'order', 'status'], 'query string');

  const companyId = validateCompanyIdQuery(query);
  const page = common.pagination(query, {
    defaultLimit: 25,
    maxLimit: config.billing.maxPageSize,
    sortable: PAYMENT_SORTABLE,
    defaultSort: 'paidAt',
  });

  const status = query.status === undefined || query.status === null || query.status === ''
    ? null
    : common.enumValue(query.status, 'status', ['PENDING', 'PAID', 'FAILED', 'REFUNDED']);

  return { companyId, ...page, status };
}

/**
 * Validate DELETE /billing/subscription.
 *
 * `atPeriodEnd` defaults to TRUE — the customer keeps what they have already
 * paid for until the period they paid for runs out. Immediate cancellation
 * forfeits the remainder, so it has to be asked for explicitly; defaulting the
 * other way would make a mis-click destroy paid time.
 */
function validateCancelRequest(body = {}) {
  common.rejectUnknown(body, ['companyId', 'atPeriodEnd']);
  common.requireFields(body, ['companyId']);

  return {
    companyId: common.parseId(body.companyId, 'companyId'),
    atPeriodEnd: common.boolean(body.atPeriodEnd, 'atPeriodEnd', { defaultValue: true }),
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
  common.rejectUnknown(body, ['companyId', 'employeeCount', 'contractorCount']);
  common.requireFields(body, ['companyId']);

  const companyId = common.parseId(body.companyId, 'companyId');

  const hasEmployees = body.employeeCount !== undefined && body.employeeCount !== null;
  const hasContractors = body.contractorCount !== undefined && body.contractorCount !== null;
  if (!hasEmployees && !hasContractors) {
    throw new ApiError(400, 'Provide employeeCount, contractorCount, or both.', {
      code: 'VALIDATION_ERROR',
      fields: { employeeCount: 'Provide at least one count to change.' },
    });
  }

  return {
    companyId,
    employeeCount: hasEmployees
      ? validateCount(body.employeeCount, 'employeeCount', config.billing.maxEmployeeCount, 'INVALID_EMPLOYEE_COUNT')
      : null,
    contractorCount: hasContractors
      ? validateCount(body.contractorCount, 'contractorCount', config.billing.maxContractorCount, 'INVALID_CONTRACTOR_COUNT')
      : null,
  };
}

/** Validate POST /billing/portal. */
function validatePortalRequest(body = {}) {
  common.rejectUnknown(body, ['companyId']);
  common.requireFields(body, ['companyId']);
  return { companyId: common.parseId(body.companyId, 'companyId') };
}

module.exports = {
  validateCheckoutRequest,
  validateAddServicesRequest,
  validateSessionId,
  validateCompanyIdQuery,
  validatePaymentsQuery,
  validateCancelRequest,
  validatePayrollUpdate,
  validatePortalRequest,
  parseId: common.parseId,
  // exported for unit testing
  _internals: { validateCount, validateOptionId, isSelected, parseSelectedServices },
};
