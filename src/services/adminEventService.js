'use strict';

const realtime = require('./realtimeService');
const dto = require('../dto/companyDto');

/**
 * The event vocabulary of the admin channel, in one file.
 *
 * realtimeService is transport — it knows about sockets, tickets and framing and
 * nothing about companies. This is the layer above it: what the admin screens
 * are told, in what shape, and when. Keeping it here means a publisher cannot
 * quietly invent a seventh event name that no client listens for, and the
 * frontend contract can be read end to end without grepping the services.
 *
 * EVERY function here must be called AFTER the database transaction that caused
 * it has committed. Publishing from inside one broadcasts a change a rollback
 * can still erase, and the admins holding it would then be the only place it
 * ever existed.
 *
 * Event names and payloads:
 *
 *   company.created                       { company }
 *   company.updated                       { company }
 *   company.archived                      { companyId, company }
 *   company.accounting_manager.assigned   { company, previousAccountingManagerUserId }
 *   company.accounting_manager.removed    { company, previousAccountingManagerUserId }
 *   company.services.changed              { companyId, subscriptionId, status }
 *   company.team.changed                  { companyId, team }
 *   user.changed                          { user, eligibleAsAccountingManager, eligibleAsSpecialist }
 *
 * `company` is always the toCompanyWithPeople shape, so a client applies every
 * company event through one code path: find the row by `id`, replace it (or drop
 * it, for `archived`). It carries `accountingManager` as a person object —
 * userId, firstName, lastName, email — which is what the row displays, so no
 * follow-up request is needed to redraw it.
 *
 * The two events that do NOT carry a whole company are the two whose payload the
 * table cannot be redrawn from: a services change is decided by Stripe and its
 * effect on the row (active services, billing date) is a join away, and a team
 * change ships the team itself. Both name the `companyId` so a listener can
 * refetch just that row.
 */

/** A newly onboarded company, including any manager it inherited. */
function companyCreated(company) {
  realtime.publish('company.created', { company: dto.toCompanyWithPeople(company) });
}

/** Company details changed (name, email, phone, head count, revenue, address). */
function companyUpdated(company) {
  realtime.publish('company.updated', { company: dto.toCompanyWithPeople(company) });
}

/**
 * A company was soft-deleted. `companyId` is called out at the top level because
 * dropping the row is all a listener has to do, and it should not have to reach
 * into the company object to find the key.
 */
function companyArchived(company) {
  realtime.publish('company.archived', { companyId: company.id, company: dto.toCompany(company) });
}

/** A manager was attached to a company, replacing whoever was there before. */
function accountingManagerAssigned(company, previousAccountingManagerUserId) {
  realtime.publish('company.accounting_manager.assigned', {
    company: dto.toCompanyWithPeople(company),
    previousAccountingManagerUserId: previousAccountingManagerUserId ?? null,
  });
}

/** A company was left with no accounting manager. */
function accountingManagerRemoved(company, previousAccountingManagerUserId) {
  realtime.publish('company.accounting_manager.removed', {
    company: dto.toCompanyWithPeople(company),
    previousAccountingManagerUserId: previousAccountingManagerUserId ?? null,
  });
}

/**
 * A company's active services changed — a checkout completed, a subscription
 * went past due, was cancelled, or head counts moved.
 *
 * Only the identifiers travel. What the table shows (which services, the billing
 * date) is a join across the subscription, its items and the plan catalog, and
 * assembling that here would mean two places computing the same row — one of
 * which is never exercised by a page load. The listener refetches the row.
 */
function companyServicesChanged({ companyId, subscriptionId, status }) {
  if (!companyId) return;
  realtime.publish('company.services.changed', {
    companyId,
    subscriptionId: subscriptionId ?? null,
    status: status ?? null,
  });
}

/**
 * A company's specialist team changed. Ships the team itself — the same shape
 * GET /companies/:companyId/team returns — so the "Team Members" cell redraws
 * without a follow-up request.
 */
function companyTeamChanged(company, assignments) {
  if (!company) return;
  realtime.publish('company.team.changed', {
    companyId: company.id,
    team: dto.toTeam({ company, assignments: assignments ?? [] }),
  });
}

/**
 * A user's name, role or account status changed.
 *
 * Published for ANY user, not only for the ones currently assignable, because
 * the interesting transitions are precisely the ones that cross the boundary:
 * the user who has just BECOME an accounting manager belongs in the picker, and
 * the one who has just stopped being one has to leave it. A publisher that
 * filtered on "is eligible" would announce the first and swallow the second, and
 * the option would sit in every open dropdown until the page was reloaded.
 *
 * The two `eligibleAs…` fields state the server's verdict rather than leaving
 * the client to re-derive it from role and status — the same rules live in
 * companyService, and two copies of an authorization rule is one copy too many.
 * `eligibleAsSpecialist` is the specific role they may be assigned for
 * (`SPECIALIST_2`…) or null, because specialist eligibility is per service: a
 * bare boolean could not say WHICH dropdown to add them to.
 *
 * The payload never includes a password hash, a token, or any login-security
 * column — the same fields the user directory returns and nothing more.
 *
 * @param {object} user  A user row selected with role/specificRole joined.
 */
function userChanged(user) {
  if (!user) return;
  const role = user.role?.code ?? null;
  const active = user.status === 'ACTIVE';
  realtime.publish('user.changed', {
    user: dto.toDirectoryUser(user),
    eligibleAsAccountingManager: active && role === 'ACCOUNTING_MANAGER',
    eligibleAsSpecialist: active && role === 'SPECIALIST' ? user.specificRole?.code ?? null : null,
  });
}

module.exports = {
  companyCreated,
  companyUpdated,
  companyArchived,
  accountingManagerAssigned,
  accountingManagerRemoved,
  companyServicesChanged,
  companyTeamChanged,
  userChanged,
};
