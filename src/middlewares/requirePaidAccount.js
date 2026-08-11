'use strict';

const onboardingService = require('../services/onboardingService');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

/**
 * Hold an owner outside the portal until every company they own is paid for.
 *
 * The flags on GET /onboarding always described this rule, but nothing enforced
 * it: they were a hint for the client's router and no more. A caller who skipped
 * the UI — or simply kept the tab open after their subscription lapsed — could
 * go on creating projects and uploading documents against a company that was
 * never billed. The frontend can decide which SCREEN to show; it cannot be what
 * decides whether the work is allowed.
 *
 * WHO THIS APPLIES TO
 * -------------------
 * Owners only, and that is the whole of it. Staff (ADMIN, ACCOUNTING_MANAGER,
 * SPECIALIST) are employees who never own a company and never see a bill —
 * gating them on a subscription would lock the people who service the account
 * out of it. Teammates (CUSTOMER/TEAM) are on somebody else's account, already
 * paid for by whoever owns it, and they have no endpoint that could ever settle
 * it; blocking them would be a dead end with no way out.
 *
 * So the gate reads `isOwner`, and everyone else passes straight through.
 *
 * WHY IT ASKS onboardingService RATHER THAN QUERYING
 * --------------------------------------------------
 * `getStatus` is what GET /onboarding returns. Reusing it means the condition
 * that blocks a request and the flag the client reads to explain the block are
 * computed by the same function — they cannot drift into disagreeing, which is
 * the failure mode where a client is told it is finished and then refused. It
 * costs one indexed read, memoised per request below.
 *
 * WHERE IT MUST NOT BE MOUNTED
 * ----------------------------
 * Not on /billing, /onboarding, /companies, /users or /auth. Those are the
 * routes an unpaid owner needs precisely BECAUSE they are unpaid: to see the
 * company, pick services, and pay. A gate across them would be a locked door
 * with the key on the inside.
 */
async function requirePaidAccount(req, res, next) {
  if (!req.user) {
    return next(new ApiError(401, 'Authentication required.', { code: 'AUTH_REQUIRED' }));
  }

  let status;
  try {
    // Memoised for the lifetime of the request, so mounting this on a router
    // that already ran it costs nothing the second time.
    if (req.user._onboardingStatus === undefined) {
      req.user._onboardingStatus = await onboardingService.getStatus(req.user.id);
    }
    status = req.user._onboardingStatus;
  } catch (err) {
    // A missing subject is already a 401 from getStatus; anything else is ours.
    if (err instanceof ApiError) return next(err);
    logger.error(`[${req.id}] Could not verify account payment state: ${err.message}`);
    return next(err);
  }

  const { isOwner, complete, companyCreated, paymentComplete } = status.onboarding;

  // Not an owner: no company to pay for, nothing to gate.
  if (!isOwner) return next();
  if (complete) return next();

  logger.info(
    `[${req.id}] Owner ${req.user.id} blocked from ${req.method} ${req.originalUrl}: ` +
      `companyCreated=${companyCreated} paymentComplete=${paymentComplete}.`
  );

  /*
   * 402 rather than 403. This is not "you may never do this" — it is "there is
   * an outstanding bill", a state the caller can leave on their own, and the
   * status code should say which of the two it is. The details carry the step
   * that is missing so the client can route without a second call.
   */
  return next(
    new ApiError(
      402,
      companyCreated
        ? 'Complete payment for your company to continue.'
        : 'Finish setting up your company to continue.',
      {
        code: 'PAYMENT_REQUIRED',
        details: { companyCreated, paymentComplete },
      }
    )
  );
}

module.exports = requirePaidAccount;
