/**
 * Seeds the reference data the portal cannot function without: the role
 * hierarchy and the bootstrap admin.
 *
 * Idempotent — every write is an upsert keyed on a natural unique column, so
 * running it repeatedly (or after a migration) converges rather than
 * duplicating.
 *
 *   npm run db:seed
 */
'use strict';

const { prisma } = require('../src/config/prisma');

// Explicit ids keep the hierarchy stable across environments: specific roles
// reference roles by id, and invitations reference both. The sequences are
// resynced at the end so later inserts don't collide with these.
const ROLES = [
  { id: 1, code: 'ADMIN', name: 'Administrator' },
  { id: 2, code: 'ACCOUNTING_MANAGER', name: 'Accounting Manager' },
  { id: 3, code: 'SPECIALIST', name: 'Specialist' },
  { id: 4, code: 'CUSTOMER', name: 'Customer' },
];

// ADMIN and ACCOUNTING_MANAGER are intentionally absent: they have no
// subdivisions, which is why User.specificRoleId is nullable.
const SPECIFIC_ROLES = [
  { id: 1, roleId: 4, code: 'OWNER', name: 'Owner' },
  { id: 2, roleId: 4, code: 'TEAM', name: 'Team' },
  { id: 3, roleId: 3, code: 'SPECIALIST_1', name: 'Payroll Specialist' },
  { id: 4, roleId: 3, code: 'SPECIALIST_2', name: 'Tax Specialist' },
  { id: 5, roleId: 3, code: 'SPECIALIST_3', name: 'Bookkeeping Specialist' },
  { id: 6, roleId: 3, code: 'SPECIALIST_4', name: 'FP&A Specialist' },
];

// Accounting specializations a specialist can be assigned to a company for
// (company_specialist_assignments references these). `FA_Q` uses a configurable
// code for "FA and Q" so the label can change without breaking assignments.
const SPECIALIZATIONS = [
  { code: 'BOOKKEEPING', name: 'Bookkeeping' },
  { code: 'PAYROLL', name: 'Payroll' },
  { code: 'TAX', name: 'Tax' },
  { code: 'FA_Q', name: 'FA and Q' },
];

/*
 * Sellable Stripe Prices, mirrored locally. `code` is OUR identifier: the
 * frontend sends an option id (bookkeeping_option_2, tax_option_3,
 * payroll_standard — see src/config/serviceCatalog.js), that resolves to one of
 * the codes below, and only then is a Stripe price id read out of this table. A
 * client can never pick its own price.
 *
 * These rows mirror the catalog loaded by hand into `service_plans`. Keeping the
 * two in step matters more than it looks: this seeder upserts on stripePriceId,
 * so a stale row here would silently overwrite a live plan's amount or
 * deactivate it the next time anyone runs `npm run db:seed`.
 *
 * `amount` is a DISPLAY CACHE, not the truth. Stripe owns pricing, and the
 * checkout flow re-reads every Price from Stripe before selling it (see
 * planCatalogService). Update these figures when pricing changes so the catalog
 * endpoint shows the right numbers, but never treat them as authoritative.
 *
 * `isAddOn` / `quantityEnabled` / `quantityLabel` describe the two per-unit
 * payroll lines; `displayOrder` fixes the order the tiers are listed in.
 */
const SERVICE_PLANS = [
  // --- Bookkeeping: one product, four selectable tiers -------------------
  { code: 'BOOKKEEPING_STARTER', name: 'Bookkeeping Starter', specializationCode: 'BOOKKEEPING', stripeProductId: 'prod_TCEyhHl368bLaq', stripePriceId: 'price_1SFqU4FGFESLnZlWYtFLbO8Z', amount: '99.00', currency: 'USD', interval: 'MONTH', isActive: true, displayOrder: 10 },
  { code: 'BOOKKEEPING_GROWTH', name: 'Bookkeeping Growth', specializationCode: 'BOOKKEEPING', stripeProductId: 'prod_TCEyhHl368bLaq', stripePriceId: 'price_1SIlL4FGFESLnZlWCsPrC2KJ', amount: '249.00', currency: 'USD', interval: 'MONTH', isActive: true, displayOrder: 20 },
  // $449, not $499 — verified against the Stripe Price, which is the authority.
  { code: 'BOOKKEEPING_SCALE', name: 'Bookkeeping Scale', specializationCode: 'BOOKKEEPING', stripeProductId: 'prod_TCEyhHl368bLaq', stripePriceId: 'price_1SIlMjFGFESLnZlWGiNjqqnT', amount: '449.00', currency: 'USD', interval: 'MONTH', isActive: true, displayOrder: 30 },
  { code: 'BOOKKEEPING_PREMIUM', name: 'Bookkeeping Premium', specializationCode: 'BOOKKEEPING', stripeProductId: 'prod_TCEyhHl368bLaq', stripePriceId: 'price_1SIlNUFGFESLnZlW4r1Zu7Oc', amount: '799.00', currency: 'USD', interval: 'MONTH', isActive: true, displayOrder: 40 },

  // --- Tax: one product, three selectable tiers + one legacy price -------
  { code: 'TAX_UNDER_500K', name: 'Tax - Under $500K Revenue', specializationCode: 'TAX', stripeProductId: 'prod_TCF1EFDtzx3VsA', stripePriceId: 'price_1SFqXpFGFESLnZlWrib36pcn', amount: '63.00', currency: 'USD', interval: 'MONTH', isActive: true, displayOrder: 10 },
  { code: 'TAX_500K_TO_2M', name: 'Tax - $500K to $2M Revenue', specializationCode: 'TAX', stripeProductId: 'prod_TCF1EFDtzx3VsA', stripePriceId: 'price_1T9eoqFGFESLnZlWNc4cUzJi', amount: '125.00', currency: 'USD', interval: 'MONTH', isActive: true, displayOrder: 20 },
  { code: 'TAX_2M_TO_10M', name: 'Tax - $2M to $10M Revenue', specializationCode: 'TAX', stripeProductId: 'prod_TCF1EFDtzx3VsA', stripePriceId: 'price_1SIlWDFGFESLnZlWbcib6b9g', amount: '233.00', currency: 'USD', interval: 'MONTH', isActive: true, displayOrder: 30 },
  /*
   * Deliberately has NO option id in serviceCatalog.js, so it cannot be sold.
   * It stays active only so existing subscribers on it keep resolving; set
   * isActive: false here (and re-seed) once nobody is left on it.
   */
  { code: 'TAX_LEGACY_1499', name: 'Tax - Legacy $1,499 Plan', specializationCode: 'TAX', stripeProductId: 'prod_TCF1EFDtzx3VsA', stripePriceId: 'price_1SIlSLFGFESLnZlWBGH3ISEW', amount: '1499.00', currency: 'USD', interval: 'MONTH', isActive: true, displayOrder: 40 },

  // --- Payroll: base + two per-unit add-ons, all on one product ----------
  { code: 'PAYROLL_BASE', name: 'Payroll Base', specializationCode: 'PAYROLL', stripeProductId: 'prod_TFFu2ZJDKGikWU', stripePriceId: 'price_1TXGGIFGFESLnZlWIepEMXv3', amount: '29.00', currency: 'USD', interval: 'MONTH', isActive: true, displayOrder: 10 },
  { code: 'PAYROLL_1099_CONTRACTOR', name: '1099 Contractor Add-On', specializationCode: 'PAYROLL', stripeProductId: 'prod_TFFu2ZJDKGikWU', stripePriceId: 'price_1SIlR1FGFESLnZlWIcQAiY3i', amount: '10.00', currency: 'USD', interval: 'MONTH', isActive: true, isAddOn: true, quantityEnabled: true, quantityLabel: 'Number of 1099 Contractors', displayOrder: 20 },
  { code: 'PAYROLL_W2_EMPLOYEE', name: 'W-2 Employee Add-On', specializationCode: 'PAYROLL', stripeProductId: 'prod_TFFu2ZJDKGikWU', stripePriceId: 'price_1SIlPwFGFESLnZlWqxd0WI1O', amount: '15.00', currency: 'USD', interval: 'MONTH', isActive: true, isAddOn: true, quantityEnabled: true, quantityLabel: 'Number of W-2 Employees', displayOrder: 30 },
];

// The first admin, who sends the initial invitations. No passwordHash: they
// set one through the normal account flow.
const BOOTSTRAP_ADMIN = {
  email: 'admin@finopsys.ai',
  firstName: 'Admin',
  lastName: 'User',
  roleId: 1,
  status: 'ACTIVE',
};

async function main() {
  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { code: role.code },
      update: { name: role.name },
      create: role,
    });
  }
  console.log(`  roles           ${ROLES.length} upserted`);

  for (const sr of SPECIFIC_ROLES) {
    await prisma.specificRole.upsert({
      where: { roleId_code: { roleId: sr.roleId, code: sr.code } },
      update: { name: sr.name },
      create: sr,
    });
  }
  console.log(`  specific_roles  ${SPECIFIC_ROLES.length} upserted`);

  for (const spec of SPECIALIZATIONS) {
    await prisma.specialization.upsert({
      where: { specializationCode: spec.code },
      update: { specializationName: spec.name },
      create: { specializationCode: spec.code, specializationName: spec.name },
    });
  }
  console.log(`  specializations ${SPECIALIZATIONS.length} upserted`);

  // Keyed on stripePriceId, not planCode: the Stripe price is the real identity
  // of a plan, so re-running after a code rename updates the row instead of
  // creating a second plan that charges the same price.
  for (const plan of SERVICE_PLANS) {
    const specialization = await prisma.specialization.findUnique({
      where: { specializationCode: plan.specializationCode },
    });
    const data = {
      specializationId: specialization?.id ?? null,
      planCode: plan.code,
      planName: plan.name,
      stripeProductId: plan.stripeProductId,
      stripePriceId: plan.stripePriceId,
      amount: plan.amount,
      currency: plan.currency,
      billingInterval: plan.interval,
      isActive: plan.isActive,
      isAddOn: Boolean(plan.isAddOn),
      quantityEnabled: Boolean(plan.quantityEnabled),
      quantityLabel: plan.quantityLabel ?? null,
      displayOrder: plan.displayOrder ?? 0,
    };
    await prisma.servicePlan.upsert({
      where: { stripePriceId: plan.stripePriceId },
      update: data,
      create: data,
    });
  }
  const activePlans = SERVICE_PLANS.filter((p) => p.isActive).length;
  console.log(
    `  service_plans   ${SERVICE_PLANS.length} upserted (${activePlans} active)` +
      (activePlans === 0 ? ' — set real amounts + isActive before selling' : '')
  );

  await prisma.user.upsert({
    where: { email: BOOTSTRAP_ADMIN.email },
    update: {},
    create: BOOTSTRAP_ADMIN,
  });
  console.log(`  users           1 upserted (${BOOTSTRAP_ADMIN.email})`);

  // Explicit ids above bypass the sequences, which would otherwise still be at
  // 1 and cause duplicate-key errors on the next autoincrement insert.
  for (const table of ['roles', 'specific_roles', 'users']) {
    await prisma.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'),
                     COALESCE((SELECT MAX(id) FROM "${table}"), 1))`
    );
  }
  console.log('  sequences       resynced');
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log('Seed complete.');
  })
  .catch(async (err) => {
    console.error('Seed failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
