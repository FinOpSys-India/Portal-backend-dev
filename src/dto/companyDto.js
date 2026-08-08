'use strict';

const catalog = require('../config/serviceCatalog');
const money = require('../utils/money');

/**
 * Response DTOs for the company flows. These are the ONLY shapes that leave the
 * service, so the API contract is defined in one place and internal columns
 * (soft-delete tombstones, raw FK ids we don't want to expose, etc.) never leak
 * by accident. Every id is serialized as a number, matching the integer surrogate
 * keys used throughout the schema.
 *
 * Keys are camelCase, matching every other module. The request side still
 * accepts snake_case (see middlewares/normalizeRequest), so a client written
 * against the older snake_case responses keeps working on the way IN — but there
 * is exactly one shape on the way OUT, which is what lets a client model the API
 * once instead of once per router.
 */

/** A Prisma Decimal (or string/number) rendered as a fixed-2 decimal string. */
function decimalString(value) {
  if (value === null || value === undefined) return null;
  // Prisma Decimal has toFixed; strings/numbers fall back to Number().
  if (typeof value.toFixed === 'function') return value.toFixed(2);
  return Number(value).toFixed(2);
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value ?? null;
}

/** Minimal person view used inside the team payload. */
function toPerson(user) {
  if (!user) return null;
  return {
    userId: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email ?? null,
  };
}

/** The company object returned by onboarding, updates, and manager assignment. */
function toCompany(company) {
  return {
    id: company.id,
    companyName: company.companyName,
    companyType: company.companyType,
    companyEmail: company.companyEmail,
    companyPhone: company.companyPhone,
    employeeCount: company.employeeCount,
    lastYearRevenue: decimalString(company.lastYearRevenue),
    revenueCurrency: company.revenueCurrency,
    ownerUserId: company.ownerUserId,
    accountingManagerUserId: company.accountingManagerUserId ?? null,
    bookkeepingSpecialistUserId: company.bookkeepingSpecialistUserId ?? null,
    payrollSpecialistUserId: company.payrollSpecialistUserId ?? null,
    taxSpecialistUserId: company.taxSpecialistUserId ?? null,
    status: company.status,
    onboardingCompleted: company.onboardingCompleted,
    createdAt: iso(company.createdAt),
    updatedAt: iso(company.updatedAt),
  };
}

/** An address row rendered back to the client. */
function toAddress(address) {
  if (!address) return null;
  return {
    id: address.id,
    addressLine1: address.line1,
    addressLine2: address.line2 ?? null,
    city: address.city,
    state: address.state ?? null,
    postalCode: address.postalCode ?? null,
    country: address.country,
    countryCode: address.countryCode ?? null,
  };
}

/**
 * The full onboarding response: company + its primary address + the accounting
 * manager the new company inherited, if any.
 *
 * `accountingManager` is always present as a key (null when nothing was
 * inherited) rather than appearing only on the companies that got one — a client
 * that has to check whether a field exists before reading it will eventually
 * forget to.
 */
function toCompanyOnboardingResponse({ company, address, accountingManager = null }) {
  return {
    company: toCompany(company),
    primaryAddress: toAddress(address),
    accountingManager: toPerson(accountingManager),
  };
}

/**
 * A company with its people joined onto it, and no address.
 *
 * This is what the accounting-manager writes return: enough for the caller to
 * redraw the row it just changed (the company, the staff names, their emails)
 * and nothing more. Deliberately NOT toCompanyDetail — that carries a
 * `primaryAddress`, and an assignment response that returned `primaryAddress:
 * null` merely because the write did not join the address table would look to a
 * client like "the address was cleared".
 *
 * The three specialist keys are always present, `null` when unset — same reason
 * `accountingManager` is: a client reads `company.taxSpecialist?.userId`
 * uniformly instead of discovering that one endpoint omits the field.
 */
function toCompanyWithPeople(company) {
  return {
    ...toCompany(company),
    owner: toPerson(company.owner),
    accountingManager: toPerson(company.accountingManager),
    bookkeepingSpecialist: toPerson(company.bookkeepingSpecialist),
    payrollSpecialist: toPerson(company.payrollSpecialist),
    taxSpecialist: toPerson(company.taxSpecialist),
  };
}

/**
 * A company with its primary address and the caller's relationship to it, used
 * by the detail and list endpoints. `accessRole` tells the frontend which
 * actions to render without it having to re-derive the authorization rules —
 * the server already knows the answer, and duplicating that logic in the client
 * is how the two drift apart.
 */
function toCompanyDetail({ company, address, accessRole }) {
  return {
    ...toCompanyWithPeople(company),
    primaryAddress: toAddress(address),
    ...(accessRole ? { accessRole } : {}),
  };
}

/** One specialist-assignment row (used by GET /specialists and the POST result). */
function toAssignment(assignment) {
  return {
    assignmentId: assignment.id,
    companyId: assignment.companyId,
    specialistUserId: assignment.specialistUserId,
    specializationCode: assignment.specialization?.specializationCode ?? null,
    specializationName: assignment.specialization?.specializationName ?? null,
    assignmentStatus: assignment.assignmentStatus,
    assignedAt: iso(assignment.assignedAt),
    unassignedAt: iso(assignment.unassignedAt),
    // Always present as a key — null rather than absent when the join was not
    // loaded, so a client can read `assignment.specialist?.userId` uniformly
    // instead of discovering that one endpoint omits the field entirely.
    specialist: toPerson(assignment.specialist),
  };
}

/**
 * The team payload:
 *   { companyId, owner, accountingManager, specialists: [{ ..., specializations }] }
 *
 * `assignments` is the list of ACTIVE assignments (with specialist +
 * specialization included); this collapses them to one entry per specialist.
 * Each specialization keeps its own `assignmentId`, so a "remove" button
 * rendered from this payload has the id it needs — previously it did not, and
 * the client had to call the specialists endpoint as well.
 */
function toTeam({ company, assignments }) {
  const bySpecialist = new Map();
  for (const a of assignments) {
    const key = a.specialistUserId;
    if (!bySpecialist.has(key)) {
      bySpecialist.set(key, { ...toPerson(a.specialist), specializations: [] });
    }
    const code = a.specialization?.specializationCode;
    if (!code) continue;
    const entry = bySpecialist.get(key);
    if (entry.specializations.some((s) => s.specializationCode === code)) continue;
    entry.specializations.push({
      assignmentId: a.id,
      specializationCode: code,
      specializationName: a.specialization?.specializationName ?? null,
    });
  }

  return {
    companyId: company.id,
    owner: toPerson(company.owner),
    accountingManager: toPerson(company.accountingManager),
    specialists: [...bySpecialist.values()],
  };
}

/* ---------------------------- active services ----------------------------- */

/**
 * What a company is currently paying for, derived from its ACTIVE subscription.
 *
 * Grouped by SERVICE, not by plan. A payroll subscription is three line items —
 * the base plan, a per-employee price, and a per-contractor price — and listing
 * them flat would report a company as having three services when it has one.
 * The grouping key is `service_plans.specialization_id`, which is the schema's
 * own answer to "which service does this plan sell?".
 *
 * Quantity-based add-ons keep their own entry with the quantity and the label
 * the catalog already stores (`quantity_label`, e.g. "Number of W-2 Employees"),
 * so payroll head counts arrive named rather than as two anonymous numbers the
 * client has to know the order of. `component` ('employees' / 'contractors')
 * comes from the service catalog for clients that would rather match on a code
 * than on a label.
 *
 * Items at quantity 0 are dropped: the row survives so the line can be re-added
 * and so history is not lost, but zero contractors is not a service.
 *
 * @param {object|null} subscription  ACTIVE subscription with items + plans + specialization.
 */
function toActiveServices(subscription) {
  if (!subscription) return [];

  const byService = new Map();

  for (const item of subscription.items ?? []) {
    const plan = item.servicePlan;
    const specialization = plan?.specialization;
    if (!plan || !specialization || item.quantity <= 0) continue;

    if (!byService.has(specialization.id)) {
      byService.set(specialization.id, {
        specializationId: specialization.id,
        specializationCode: specialization.specializationCode,
        specializationName: specialization.specializationName,
        planCode: null,
        planName: null,
        addOns: [],
      });
    }
    const view = byService.get(specialization.id);

    if (plan.isAddOn) {
      view.addOns.push({
        planCode: plan.planCode,
        planName: plan.planName,
        component: catalog.BY_PLAN_CODE.get(plan.planCode)?.component ?? null,
        quantityLabel: plan.quantityLabel ?? null,
        quantity: item.quantity,
      });
      continue;
    }

    // The base plan names the tier the company is on. There is exactly one per
    // service on a well-formed subscription; if a second ever appears, the first
    // is kept rather than silently overwritten.
    view.planCode ??= plan.planCode;
    view.planName ??= plan.planName;
  }

  return [...byService.values()];
}

/**
 * The billing block behind the "Billing Date" column. Null when the company has
 * no ACTIVE subscription — which is a real state (onboarded but never checked
 * out), not an error, and the column should read empty rather than invent a date.
 */
function toBillingSummary(subscription) {
  if (!subscription) return null;
  return {
    subscriptionId: subscription.id,
    status: subscription.status,
    currentPeriodStart: iso(subscription.currentPeriodStart),
    // The "Billing Date" column renders this: the end of the paid period, which
    // is when the next invoice is raised.
    currentPeriodEnd: iso(subscription.currentPeriodEnd),
    cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
  };
}

/**
 * A company with everything the screens actually render: the company itself, its
 * owner, the plans it is paying for, when it next bills, and who works on it.
 *
 * Used by EVERY company read, not just the admin table — the customer's own
 * dashboard, a specialist's list of accounts, and the admin grid all show the
 * same facts about a company, so they get the same object. What differs between
 * them is WHICH companies come back (the access filter) and `accessRole`, not
 * the shape of a row. One shape means a client models a company once.
 *
 * `teamMembers` is the SAME shape as GET /companies/:companyId/team, so a client
 * models "the team" once instead of once per screen. `teamMemberCount` is stated
 * rather than left to the client to add up, because who counts as a member (the
 * owner? an accounting manager with no specialists?) is a server-side rule.
 */
function toCompanyAccountRow({ company, address, subscription, assignments, accessRole }) {
  const team = toTeam({ company, assignments });
  return {
    ...toCompanyDetail({ company, address, accessRole }),
    activeServices: toActiveServices(subscription),
    billing: toBillingSummary(subscription),
    teamMembers: team,
    teamMemberCount:
      (team.owner ? 1 : 0) + (team.accountingManager ? 1 : 0) + team.specialists.length,
  };
}

/* ------------------------ the accounting manager's view ------------------- */

/**
 * The service plans on an account, priced.
 *
 * Richer than `activeServices`, which answers "what does this company have?" for
 * a table cell. This answers the question a manager actually asks about an
 * account they are responsible for: which plan is each service on, at what
 * price, billed how often, and what does the line come to.
 *
 * Amounts come from `company_subscription_items.unit_amount` — the price
 * captured at purchase — never from the current catalog. That is the whole
 * reason the column is duplicated: a customer who bought at $249 must keep
 * reading $249 after the list price moves, or the manager and the customer's
 * invoice disagree.
 *
 * Minor units in `...AmountMinor`, matching every other money field in the API.
 */
function toServicePlans(subscription) {
  if (!subscription) return [];

  const byService = new Map();

  for (const item of subscription.items ?? []) {
    const plan = item.servicePlan;
    const specialization = plan?.specialization;
    if (!plan || !specialization || item.quantity <= 0) continue;

    const currency = (item.currency || '').toUpperCase();
    const unitAmountMinor = money.decimalToMinor(item.unitAmount, currency);
    const line = {
      planCode: plan.planCode,
      planName: plan.planName,
      component: catalog.BY_PLAN_CODE.get(plan.planCode)?.component ?? null,
      quantityLabel: plan.quantityLabel ?? null,
      quantity: item.quantity,
      unitAmountMinor,
      totalAmountMinor: money.multiply(unitAmountMinor, item.quantity),
      currency,
      billingInterval: plan.billingInterval ?? null,
    };

    if (!byService.has(specialization.id)) {
      byService.set(specialization.id, {
        specializationId: specialization.id,
        specializationCode: specialization.specializationCode,
        specializationName: specialization.specializationName,
        planCode: null,
        planName: null,
        lines: [],
        totalAmountMinor: 0,
        currency,
      });
    }
    const view = byService.get(specialization.id);

    // The base plan names the tier; add-ons are the quantity-based components.
    if (!plan.isAddOn) {
      view.planCode ??= plan.planCode;
      view.planName ??= plan.planName;
    }
    view.lines.push(line);
    view.totalAmountMinor += line.totalAmountMinor;
    view.currency ||= currency;
  }

  return [...byService.values()];
}

/**
 * Everyone working on an account, with enough detail to contact them.
 *
 * `toTeam` groups specialists by person for a compact team panel; this keeps
 * that grouping and adds what a manager needs to act — the job title that tells
 * two colleagues apart, and when each assignment started.
 */
function toCompanyMembers({ company, assignments }) {
  const bySpecialist = new Map();

  for (const a of assignments) {
    const key = a.specialistUserId;
    if (!bySpecialist.has(key)) {
      bySpecialist.set(key, {
        ...toPerson(a.specialist),
        jobTitle: a.specialist?.jobTitle ?? null,
        specializations: [],
      });
    }
    const code = a.specialization?.specializationCode;
    if (!code) continue;
    const entry = bySpecialist.get(key);
    if (entry.specializations.some((s) => s.specializationCode === code)) continue;
    entry.specializations.push({
      assignmentId: a.id,
      specializationCode: code,
      specializationName: a.specialization?.specializationName ?? null,
      assignedAt: iso(a.assignedAt),
    });
  }

  const specialists = [...bySpecialist.values()];
  return {
    owner: toPerson(company.owner),
    accountingManager: toPerson(company.accountingManager),
    specialists,
    // Stated by the server: who counts as a member is a server-side rule.
    total: (company.owner ? 1 : 0) + (company.accountingManager ? 1 : 0) + specialists.length,
  };
}

/**
 * One account as its accounting manager sees it: the company, its priced service
 * plans, its billing period, and everyone working on it.
 *
 * Deliberately richer than the admin table row. The admin's screen answers "who
 * manages this company?" across every company; this one is a manager's working
 * view of an account they are responsible for, so it carries the detail that
 * view needs and the admin's does not.
 */
function toManagedCompany({ company, address, subscription, assignments }) {
  return {
    ...toCompanyDetail({ company, address, accessRole: 'ACCOUNTING_MANAGER' }),
    servicePlans: toServicePlans(subscription),
    // Kept alongside the priced view so one client can render either without a
    // second request — the compact form for a list, the priced form for detail.
    activeServices: toActiveServices(subscription),
    billing: toBillingSummary(subscription),
    members: toCompanyMembers({ company, assignments }),
  };
}

/* --------------------------- specialist options --------------------------- */

/**
 * The per-service picker payload behind a clicked company row.
 *
 * One entry per ACTIVE service, each carrying its OWN eligible list — a Tax
 * Specialist must never appear in the bookkeeping dropdown, and the way to
 * guarantee that is for the server to send separate lists rather than one list
 * the client filters. `requiredSpecificRole` is included so the UI can label the
 * dropdown honestly, not so it can re-derive eligibility.
 */
function toSpecialistOptions({ companyId, services }) {
  return {
    companyId,
    // How many dropdowns to render, and how many assignments the write endpoint
    // will insist on. The client does not count services itself.
    requiredAssignmentCount: services.length,
    services: services.map((service) => ({
      specializationCode: service.specializationCode,
      specializationName: service.specializationName,
      requiredSpecificRole: service.requiredSpecificRole,
      requiredSpecificRoleName: service.requiredSpecificRoleName ?? null,
      assigned: service.assigned.map((assignment) => ({
        assignmentId: assignment.id,
        ...toPerson(assignment.specialist),
      })),
      eligibleSpecialists: service.eligible.map(toDirectoryUser),
    })),
  };
}

/**
 * One company in the owner's picker: enough to render and identify the option,
 * and nothing else.
 *
 * `onboardingCompleted` is included because a company still mid-onboarding is a
 * legitimate but odd thing to invite someone onto, and the form should be able
 * to mark it rather than hide it.
 */
function toOwnedCompanyOption(company) {
  return {
    companyId: company.id,
    companyName: company.companyName,
    companyEmail: company.companyEmail,
    status: company.status,
    onboardingCompleted: company.onboardingCompleted,
  };
}

/**
 * One row of a company's teammate list.
 *
 * `joinedAt` is the membership date for THIS company, not the date the user's
 * account was created — the two differ for anyone invited onto a second company
 * later, and the screen is asking about this one. `createdAt` is returned
 * alongside it so a client can still sort by seniority of account.
 */
function toTeammateRow(user) {
  const membership = user.companyMemberships?.[0] ?? null;

  return {
    userId: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    fullName: `${user.firstName} ${user.lastName}`.trim(),
    jobTitle: user.jobTitle ?? null,
    role: user.role?.code ?? null,
    specificRole: user.specificRole?.code ?? null,
    specificRoleName: user.specificRole?.name ?? null,
    status: user.status,
    joinedAt: membership?.createdAt ?? null,
    createdAt: user.createdAt ?? null,
  };
}

/** A user as returned by the directory endpoint. Never includes a password hash. */
function toDirectoryUser(user) {
  return {
    userId: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role?.code ?? null,
    specificRole: user.specificRole?.code ?? null,
    jobTitle: user.jobTitle ?? null,
    status: user.status,
  };
}

/**
 * One row of the admin's accounting-manager table: who the manager is, and every
 * company on their book.
 *
 * `fullName` is assembled here rather than in the frontend because three screens
 * already join first and last name their own way, and a name is exactly the kind
 * of thing that should look identical everywhere it appears. The parts are still
 * returned alongside it — a table may want to sort by surname.
 *
 * `companyCount` is the length of the list in the same response, not a separate
 * COUNT: two numbers derived from two queries can disagree, and a header reading
 * "5 companies" above four rows is a bug report waiting to happen.
 */
function toAccountingManagerRow(manager) {
  const companies = (manager.managedCompanies ?? []).map((company) => ({
    companyId: company.id,
    companyName: company.companyName,
    companyEmail: company.companyEmail,
    status: company.status,
    onboardingCompleted: company.onboardingCompleted,
    createdAt: company.createdAt,
  }));

  return {
    ...toDirectoryUser(manager),
    fullName: [manager.firstName, manager.lastName].filter(Boolean).join(' '),
    companyCount: companies.length,
    companies,
  };
}

/**
 * One row of the specialist directory: who they are, what they specialise in,
 * and which of the caller's companies they serve.
 *
 * Two different notions of "speciality" are returned, because they answer two
 * different questions and collapsing them would lose one:
 *
 *   serviceSpeciality  their standing title from the role seed ("Bookkeeping
 *                      Specialist"). True of the person, and present even for
 *                      someone who is not assigned to anything yet.
 *   specialities       the service lines they actually serve WITHIN the caller's
 *                      visible companies. Empty for an unassigned specialist,
 *                      and narrower than the title when someone covers a line
 *                      outside their nominal role.
 *
 * `companies` is likewise scope-limited: it is what THIS caller may see, not the
 * specialist's whole book. An owner learns which of their own companies the
 * person works on and nothing about anyone else's.
 */
function toSpecialistRow({ user, specialities, companies }) {
  return {
    ...toDirectoryUser(user),
    fullName: [user.firstName, user.lastName].filter(Boolean).join(' '),
    serviceSpeciality: user.specificRole?.name ?? null,
    specialities,
    companyCount: companies.length,
    companies,
  };
}

/**
 * One row of the customer directory: the person, their specific role on the
 * customer side (Owner / Team), and the companies they are attached to.
 *
 * `companies` is scope-limited exactly as in the specialist directory — an
 * accounting manager asking about one company learns which customer users belong
 * to THAT account, not the rest of that person's portfolio.
 *
 * `specificRole` is returned as both code and display name: the code is what an
 * API consumer branches on and never changes, the name is what a table renders
 * and follows the seed.
 */
function toCustomerRow(user) {
  const companies = (user.ownedCompanies ?? []).map((company) => ({
    companyId: company.id,
    companyName: company.companyName,
    status: company.status,
  }));

  return {
    ...toDirectoryUser(user),
    fullName: [user.firstName, user.lastName].filter(Boolean).join(' '),
    specificRoleName: user.specificRole?.name ?? null,
    companyCount: companies.length,
    companies,
  };
}

module.exports = {
  toCompany,
  toCompanyWithPeople,
  toAccountingManagerRow,
  toSpecialistRow,
  toCustomerRow,
  toOwnedCompanyOption,
  toTeammateRow,
  toCompanyDetail,
  toAddress,
  toCompanyOnboardingResponse,
  toAssignment,
  toTeam,
  toPerson,
  toDirectoryUser,
  toActiveServices,
  toBillingSummary,
  toCompanyAccountRow,
  toServicePlans,
  toCompanyMembers,
  toManagedCompany,
  toSpecialistOptions,
};
