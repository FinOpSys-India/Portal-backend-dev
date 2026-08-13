'use strict';

const logger = require('./logger');

/**
 * Structured, allowlisted audit logging for the company onboarding and team
 * flows.
 *
 * Every event is emitted as a single JSON line so it can be shipped to a log
 * aggregator and queried by field. The allowlist is the whole point: only the
 * identifiers and status fields below are ever serialized, so sensitive values —
 * access tokens, phone numbers, full addresses, company revenue, and any other
 * PII — can never be logged even if a caller accidentally passes them. Anything
 * not named in FIELD_ALLOWLIST is dropped.
 *
 *   logEvent({ event: 'company.onboarding.completed', status: 'success',
 *              requestId, userId, companyId });
 */

// The only fields ever written. Deliberately excludes tokens, phone, address,
// and revenue. `event` and `status` are required; the rest are contextual ids.
const FIELD_ALLOWLIST = [
  'event',
  'status',
  'requestId',
  'userId',
  'companyId',
  'accountingManagerUserId',
  'specialistUserId',
  'specializationCode',
  'assignmentId',
  // Project context. Both are identifiers or counts — a project id and how many
  // rows an operation touched. The project NAME is deliberately absent: it is
  // free text a customer typed, which is exactly what this allowlist keeps out.
  'projectId',
  'projectCount',
  // Task context, on the same terms as the project ids above: an identifier and
  // a count. The task NAME and its DESCRIPTION are deliberately absent — both
  // are free text somebody typed, which is what this allowlist exists to keep
  // out of the log.
  'taskId',
  'taskCount',
  'idempotent',
  /*
   * Billing / Stripe context. All of these are identifiers, counts, or integer
   * minor-unit amounts — never a secret key, never a card detail, never a
   * webhook secret, never customer PII. `stripeCustomerId` is an opaque Stripe
   * handle (cus_…), not an email or a name, which is why it is safe to trace on.
   */
  'selectedServices',
  'planCodes',
  'stripeProductIds',
  'stripePriceIds',
  'employeeCount',
  'contractorCount',
  'amountMinor',
  'currency',
  'stripeCustomerId',
  'stripeCheckoutSessionId',
  'subscriptionId',
  'stripeSubscriptionId',
  'stripePaymentIntentId',
  'stripeInvoiceId',
  'stripeEventId',
  'stripeEventType',
  // The stable ApiError code for a failed operation (e.g. 'PAYMENT_FAILED').
  'errorCode',
  // A short, non-sensitive reason/detail (e.g. 'duplicate', 'role_missing').
  // Never put user input or PII here.
  'detail',
];

/**
 * Emit one structured audit event. Server-error events (`status: 'error'`) go to
 * the error stream; everything else is informational.
 *
 * @param {object} fields  Any subset of FIELD_ALLOWLIST. `event` is required.
 */
function logEvent(fields = {}) {
  const record = { timestamp: new Date().toISOString() };
  for (const key of FIELD_ALLOWLIST) {
    if (fields[key] !== undefined && fields[key] !== null) record[key] = fields[key];
  }
  if (!record.event) record.event = 'unknown';

  const line = JSON.stringify(record);
  if (fields.status === 'error') {
    logger.error(line);
  } else {
    logger.info(line);
  }
}

module.exports = { logEvent, FIELD_ALLOWLIST };
