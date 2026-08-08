'use strict';

const { avatarUrl } = require('./userDto');

/**
 * Response shapes for projects.
 *
 * The one rule worth stating: `deadlineDate` leaves as "YYYY-MM-DD" and never as
 * an ISO timestamp. The column is a DATE — a calendar day someone picked — and
 * serialising it as `2026-12-31T00:00:00.000Z` invites every consumer to run it
 * through `new Date()` and render 30 December to anyone west of UTC. The string
 * carries exactly the information the column holds.
 *
 * `specialist` is null on a project nobody is staffed on. That is a real state
 * rather than missing data — a company can be onboarded and unstaffed, and the
 * auto-assignment leaves the column NULL rather than attaching the wrong kind of
 * specialist (see projectService.resolveSpecialist). Every consumer has to
 * render "Unassigned", and syncSpecialists is what fills it in later.
 */

/* -------------------------------------------------------------------------- */
/* primitives                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `projects.progress_bar` as a JSON number.
 *
 * The column is NUMERIC(5,2), so Prisma hands back a Decimal OBJECT, not a
 * primitive — serialise the row as-is and the client receives
 * `{"s":1,"e":1,"d":[40]}` instead of `40`. Converting here is safe in a way it
 * would not be for money: this is a bounded percentage with two decimal places,
 * nowhere near the precision where a double starts to lie, and it is going
 * straight into a CSS width. Amounts elsewhere in this API stay strings for
 * exactly the opposite reason.
 *
 * NOT NULL with a default of 0 in the database, so the fallback below is for
 * safety rather than for a state that exists.
 */
function toPercent(value) {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

/** A DATE column as the calendar day it is, with no zone attached. */
function toDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  // Prisma hands back a Date pinned to midnight UTC for a DATE column, so the
  // UTC half of the ISO string IS the stored day. Using the local getters here
  // would be the exact bug this function exists to prevent.
  return value.toISOString().slice(0, 10);
}

/**
 * A person on a project — whoever created it, or the specialist staffed on it.
 *
 * `name` is pre-joined rather than left to the client: every screen that shows
 * one of these shows a full name, and a frontend that builds it itself has to
 * decide what to do when a part is missing.
 */
function toPerson(user) {
  if (!user) return null;
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    name: `${user.firstName} ${user.lastName}`.trim(),
    email: user.email,
    jobTitle: user.jobTitle ?? null,
    avatarUrl: avatarUrl(user.avatarKey),
  };
}

/**
 * The specialist staffed on a project, or null when nobody is.
 *
 * A person plus `specificRole` — SPECIALIST_3 and the rest — because which KIND
 * of specialist they are is the point of showing them at all. Built on toPerson
 * rather than beside it, so the two never disagree about how a name is spelled
 * or an avatar is turned into a URL.
 */
function toSpecialist(user) {
  const person = toPerson(user);
  if (!person) return null;
  return { ...person, specificRole: user.specificRole?.code ?? null };
}

/* -------------------------------------------------------------------------- */
/* the service list                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The services a company may open a project against — one entry per SERVICE,
 * not per plan.
 *
 * A company on Bookkeeping pays for one base plan and possibly several add-on
 * lines (payroll's per-employee and per-contractor components are the live
 * example). Those add-ons are not separately projectable: nobody opens "a
 * W-2-employee project". So the base plan is what identifies the service, and
 * the add-ons ride along as detail for the form to display.
 *
 * `servicePlanId` is what the create endpoint wants back. It is the id of the
 * BASE plan, which is why an entry with no base plan is dropped rather than
 * returned unselectable — offering an option the write would refuse is exactly
 * what building this server-side is meant to prevent.
 *
 * @param {Array} items rows from projectRepository.listPurchasedPlans
 */
function toServiceOptions(items) {
  const byService = new Map();

  for (const item of items ?? []) {
    const plan = item.servicePlan;
    const specialization = plan?.specialization;
    // A plan with no specialization sells no service — a bundle or a one-off.
    // It cannot be projected against, so it is not offered.
    if (!plan || !specialization) continue;

    if (!byService.has(specialization.id)) {
      byService.set(specialization.id, {
        servicePlanId: null,
        planCode: null,
        planName: null,
        specializationId: specialization.id,
        serviceCode: specialization.specializationCode,
        serviceName: specialization.specializationName,
        addOns: [],
      });
    }
    const view = byService.get(specialization.id);

    if (plan.isAddOn) {
      view.addOns.push({
        planCode: plan.planCode,
        planName: plan.planName,
        quantityLabel: plan.quantityLabel ?? null,
        quantity: item.quantity,
      });
      continue;
    }

    // Exactly one base plan per service on a well-formed subscription. If a
    // second ever appears the first is kept rather than silently overwritten —
    // the same rule companyDto.toActiveServices follows.
    view.servicePlanId ??= plan.id;
    view.planCode ??= plan.planCode;
    view.planName ??= plan.planName;
  }

  return [...byService.values()].filter((service) => service.servicePlanId !== null);
}

/* -------------------------------------------------------------------------- */
/* projects                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One row of the projects table: the project, the company it is for, the service
 * it is against, and who opened it.
 *
 * The company name is included on every row even though the list is already
 * filtered to one company. It costs one join for the whole page and it makes the
 * row self-describing — the same object is what the detail view renders, and a
 * client that cached a row does not have to hold a company lookup beside it.
 */
function toProject(project) {
  const specialization = project.servicePlan?.specialization ?? null;

  return {
    id: project.id,
    projectName: project.projectName,
    deadlineDate: toDateOnly(project.deadlineDate),
    description: project.description ?? null,

    companyId: project.companyId,
    companyName: project.company?.companyName ?? null,

    // "Service Type" in the table. The service is the specialization; the plan
    // is the tier within it, and both are sent because the column shows the
    // former and a tooltip or detail panel wants the latter.
    service: specialization
      ? {
          servicePlanId: project.servicePlanId,
          planCode: project.servicePlan?.planCode ?? null,
          planName: project.servicePlan?.planName ?? null,
          specializationId: specialization.id,
          serviceCode: specialization.specializationCode,
          serviceName: specialization.specializationName,
        }
      : null,

    // Who is doing the work. Resolved by the server from the company's staffing
    // for this service line and STORED, never taken from the request — null
    // means the line is unstaffed, not that the field was forgotten.
    specialist: toSpecialist(project.assignedSpecialist),
    createdBy: toPerson(project.createdBy),

    status: project.status,
    // 0–100, the number the bar is drawn from. Independent of `status` — see
    // the note on the column in prisma/schema.prisma.
    progressBar: toPercent(project.progressBar),

    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

/**
 * The projects screen in one response: the table, the services the company has,
 * and the paging block.
 *
 * `services` travels with the list on purpose. The screen's "New project" form
 * needs it the moment the page renders, and a second request for it would mean
 * the button is either disabled for a beat or able to open a form with an empty
 * dropdown. It is the same array GET /projects/services returns on its own, for
 * a client that only wants the form.
 */
function toProjectList({ projects, services, total, limit, offset }) {
  return {
    projects: projects.map(toProject),
    services,
    pagination: { total, limit, offset, hasMore: offset + projects.length < total },
  };
}

module.exports = {
  toDateOnly,
  toPercent,
  toPerson,
  toSpecialist,
  toServiceOptions,
  toProject,
  toProjectList,
};
