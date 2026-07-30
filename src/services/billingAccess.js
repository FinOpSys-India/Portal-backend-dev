'use strict';

const { prisma } = require('../config/prisma');
const ApiError = require('../utils/ApiError');
const companyRepo = require('../repositories/companyRepository');

/**
 * Per-company authorization for every billing operation, in one place so the
 * rule cannot drift between "start a subscription" and "cancel one".
 *
 * Billing access is deliberately NARROWER than the company read access granted
 * in companyService: an assigned specialist or the accounting manager may see a
 * company's team, but only the OWNER (or an ADMIN) may commit it to a paid
 * subscription, change what it pays, or cancel it.
 *
 * The caller is always the verified access-token subject. The company_id in the
 * request is only a lookup key — it is checked against that identity, never
 * trusted as a claim about who the caller is.
 */

function callerNotFound() {
  return new ApiError(401, 'Your account could not be found.', { code: 'USER_NOT_FOUND' });
}
function companyNotFound() {
  return new ApiError(404, 'Company not found.', { code: 'COMPANY_NOT_FOUND' });
}
function companyAccessDenied() {
  return new ApiError(403, 'You do not have access to this company.', { code: 'COMPANY_ACCESS_DENIED' });
}

/**
 * Load the caller and the company, and assert the caller may bill it.
 *
 * @returns {Promise<{ caller: object, company: object }>}
 * @throws {ApiError} 401 USER_NOT_FOUND / 404 COMPANY_NOT_FOUND / 403 COMPANY_ACCESS_DENIED
 */
async function authorizeCompany(userId, companyId, client = prisma) {
  const caller = await companyRepo.findUserWithRole(client, userId);
  if (!caller) throw callerNotFound();

  const company = await companyRepo.findCompanyById(client, companyId);
  if (!company) throw companyNotFound();

  const isAdmin = caller.role?.code === 'ADMIN';
  if (!isAdmin && company.ownerUserId !== caller.id) throw companyAccessDenied();

  return { caller, company };
}

module.exports = { authorizeCompany, companyNotFound, companyAccessDenied, callerNotFound };
