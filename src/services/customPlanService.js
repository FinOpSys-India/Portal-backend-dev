'use strict';

const { prisma } = require('../config/prisma');
const logger = require('../utils/logger');
const { authorizeCompany } = require('./billingAccess');
const emailService = require('./emailService');

const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

const REQUEST_TYPE = Object.freeze({
  NEW: 'NEW',
  REPEAT: 'REPEAT',
  FOLLOW_UP: 'FOLLOW_UP',
});

// Rows that actually reached support. REPEAT rows sent nothing.
const EMAILED_TYPES = [REQUEST_TYPE.NEW, REQUEST_TYPE.FOLLOW_UP];

/**
 * "Connect with us" for a custom service plan.
 *
 * Same access rule as the rest of billing — the company OWNER or an ADMIN — so a
 * user cannot send support a request in another company's name. The recipient
 * of the confirmation is the caller's own email from the database, never an
 * address from the request body.
 *
 * Every click is stored, tagged by what it was:
 *   NEW       no earlier emailed request for this company — emails sent
 *   REPEAT    last emailed request is under 24h old — nothing sent
 *   FOLLOW_UP last emailed request is over 24h old — emails sent, flagged
 *
 * A NEW/FOLLOW_UP row is written only AFTER the support email has gone out. If
 * that send fails nothing is stored, the caller gets the error, and the next
 * click is treated as if this one never happened — a failed send can never
 * leave a row that silences retries for 24h. The user's own confirmation is
 * best-effort and only logged.
 */
async function requestCustomPlan({ userId, companyId }) {
  const { caller, company } = await authorizeCompany(userId, companyId);

  const [lastEmailed, firstEmailed] = await Promise.all([
    prisma.customPlanRequest.findFirst({
      where: { companyId: company.id, requestType: { in: EMAILED_TYPES } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    prisma.customPlanRequest.findFirst({
      where: { companyId: company.id, requestType: { in: EMAILED_TYPES } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);

  if (lastEmailed && Date.now() - lastEmailed.createdAt.getTime() < REPEAT_WINDOW_MS) {
    const repeat = await prisma.customPlanRequest.create({
      data: { companyId: company.id, userId: caller.id, requestType: REQUEST_TYPE.REPEAT },
    });
    logger.info(`Custom plan request ${repeat.id} for company ${company.id} is a repeat; no emails sent.`);
    return toResult(repeat);
  }

  const requestType = lastEmailed ? REQUEST_TYPE.FOLLOW_UP : REQUEST_TYPE.NEW;
  const requestedAt = new Date();

  // Phone is not part of the role select billingAccess loads.
  const profile = await prisma.user.findUnique({
    where: { id: caller.id },
    select: { phone: true },
  });

  await emailService.sendCustomPlanSupportEmail({
    user: { ...caller, phone: profile?.phone },
    company,
    requestedAt,
    followUp: requestType === REQUEST_TYPE.FOLLOW_UP,
    firstRequestedAt: firstEmailed?.createdAt,
  });

  const request = await prisma.customPlanRequest.create({
    data: { companyId: company.id, userId: caller.id, requestType, createdAt: requestedAt },
  });

  try {
    await emailService.sendCustomPlanAckEmail({
      recipientEmail: caller.email,
      recipientFirstName: caller.firstName,
      company,
    });
  } catch (err) {
    logger.error(`Custom plan confirmation email failed (request ${request.id}):`, err.message);
  }

  logger.info(`Custom plan request ${request.id} (${requestType}) for company ${company.id} by user ${caller.id}.`);

  return toResult(request);
}

function toResult(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    requestType: row.requestType,
    createdAt: row.createdAt,
  };
}

module.exports = { requestCustomPlan, REQUEST_TYPE };
