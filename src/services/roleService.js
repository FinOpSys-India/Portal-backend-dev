'use strict';

const { prisma } = require('../config/prisma');

/**
 * The role catalog: what a role is called, what its subdivisions are, and — the
 * part nothing else exposes — the numeric ids that POST /invitations requires.
 *
 * Read-only, and deliberately the whole table. There are four roles and a
 * handful of specific roles; paginating a list that size would add a contract to
 * learn in exchange for nothing, and a picker that silently omitted an option
 * would be worse than a slightly larger response.
 *
 * Both the id AND the code are returned for every entry. The id is what the
 * invitation endpoint wants today; the code is what every other endpoint speaks
 * and what a client should branch on, because ids are database internals that
 * differ between environments while codes are contract. Returning both lets a
 * form submit the id without ever hardcoding one.
 */

const ROLE_SELECT = {
  id: true,
  code: true,
  name: true,
  specificRoles: {
    select: { id: true, code: true, name: true },
    orderBy: { id: 'asc' },
  },
};

/** Every role, ordered by id so the list is stable between calls. */
async function listRoles() {
  const roles = await prisma.role.findMany({
    select: ROLE_SELECT,
    orderBy: { id: 'asc' },
  });

  return roles.map((role) => ({
    roleId: role.id,
    code: role.code,
    name: role.name,
    /*
     * Says outright whether the invite form needs a second dropdown, so the
     * client does not have to infer it from an empty array — and, more to the
     * point, does not have to keep its own list of which roles have
     * subdivisions. The service that creates an invitation enforces exactly this
     * rule (a role with subdivisions demands one, a role without forbids one);
     * this is that rule, advertised.
     */
    requiresSpecificRole: role.specificRoles.length > 0,
    specificRoles: role.specificRoles.map((specificRole) => ({
      specificRoleId: specificRole.id,
      code: specificRole.code,
      name: specificRole.name,
    })),
  }));
}

module.exports = { listRoles };
