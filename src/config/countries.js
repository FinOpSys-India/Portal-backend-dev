'use strict';

/**
 * ISO 3166-1 alpha-2 country codes, plus the postal-code rules we can actually
 * enforce.
 *
 * Previously `country_code` only had to be two letters, so `XX` was accepted and
 * `{ country: "France", countryCode: "US" }` was accepted, and both went on to
 * Stripe and onto invoices. Two letters is a shape, not a country.
 *
 * POSTAL_PATTERNS is deliberately partial. A postal-code regex is only worth
 * having where it is genuinely reliable; guessing at one for every country
 * produces false rejections of real addresses, which is worse than accepting a
 * loose string. Countries not listed fall back to a length check alone.
 */

// The full ISO 3166-1 alpha-2 assignment list.
const ISO_ALPHA2 = new Set([
  'AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ',
  'BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ',
  'CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CU','CV','CW','CX','CY','CZ',
  'DE','DJ','DK','DM','DO','DZ',
  'EC','EE','EG','EH','ER','ES','ET',
  'FI','FJ','FK','FM','FO','FR',
  'GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY',
  'HK','HM','HN','HR','HT','HU',
  'ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT',
  'JE','JM','JO','JP',
  'KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ',
  'LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY',
  'MA','MC','MD','ME','MF','MG','MH','MK','ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ',
  'NA','NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ',
  'OM',
  'PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PW','PY',
  'QA',
  'RE','RO','RS','RU','RW',
  'SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SY','SZ',
  'TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ',
  'UA','UG','UM','US','UY','UZ',
  'VA','VC','VE','VG','VI','VN','VU',
  'WF','WS',
  'YE','YT',
  'ZA','ZM','ZW',
]);

/**
 * Countries with no meaningful subdivision to collect. `state` is required
 * everywhere else, which suits a US-centric portal; extend this list rather than
 * relaxing the rule globally.
 */
const NO_STATE_COUNTRIES = new Set([
  'AD','AE','AW','AX','BH','BM','BQ','BV','CW','DJ','DK','FO','GG','GI','GL','GM',
  'HK','IE','IM','IS','JE','KM','LI','LU','MC','MO','MT','NR','NU','PN','QA','SG',
  'SH','SJ','SM','ST','SX','TK','TV','VA','WS','YT',
]);

/**
 * Postal formats confident enough to enforce. Anchored, case-insensitive, and
 * applied to the value with internal whitespace preserved as the caller typed it.
 */
const POSTAL_PATTERNS = {
  US: /^\d{5}(-\d{4})?$/,
  CA: /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d$/i,
  GB: /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i,
  IN: /^\d{6}$/,
  AU: /^\d{4}$/,
  DE: /^\d{5}$/,
  FR: /^\d{5}$/,
  NL: /^\d{4}\s?[A-Z]{2}$/i,
  JP: /^\d{3}-?\d{4}$/,
  BR: /^\d{5}-?\d{3}$/,
  IT: /^\d{5}$/,
  ES: /^\d{5}$/,
  SE: /^\d{3}\s?\d{2}$/,
  PL: /^\d{2}-?\d{3}$/,
  MX: /^\d{5}$/,
  NZ: /^\d{4}$/,
  ZA: /^\d{4}$/,
  CH: /^\d{4}$/,
  AT: /^\d{4}$/,
  BE: /^\d{4}$/,
  PT: /^\d{4}-?\d{3}$/,
};

/** US state / territory codes, used when countryCode is US. */
const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS',
  'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY',
  'NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
  'WI','WY','DC','AS','GU','MP','PR','VI','AA','AE','AP',
]);

/**
 * Full US state names to their codes.
 *
 * Present so that validation does not become a usability regression: "Texas" is
 * what a person types, "TX" is what an invoice needs, and refusing the former to
 * get the latter just moves the problem to the user. Normalise instead of
 * rejecting.
 */
const US_STATE_NAMES = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
  COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA',
  HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA',
  KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
  MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS',
  MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK',
  OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT',
  VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI',
  WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC', 'PUERTO RICO': 'PR',
  GUAM: 'GU', 'AMERICAN SAMOA': 'AS', 'US VIRGIN ISLANDS': 'VI',
  'NORTHERN MARIANA ISLANDS': 'MP',
};

function isValidCountryCode(code) {
  return ISO_ALPHA2.has(String(code || '').toUpperCase());
}

/**
 * Canonicalise a state for storage.
 *
 * For the US this returns the two-letter code, accepting either the code or the
 * full name. For every other country the value is passed through untouched —
 * subdivision schemes differ too much to normalise safely, and inventing rules
 * for them would reject valid addresses.
 *
 * @returns {{ ok: boolean, value: string|null }}
 */
function normalizeState(state, countryCode) {
  const raw = String(state ?? '').trim();
  if (!raw) return { ok: true, value: null };
  if (String(countryCode || '').toUpperCase() !== 'US') return { ok: true, value: raw };

  const upper = raw.toUpperCase();
  if (US_STATES.has(upper)) return { ok: true, value: upper };

  const byName = US_STATE_NAMES[upper.replace(/\./g, '').replace(/\s+/g, ' ')];
  if (byName) return { ok: true, value: byName };

  return { ok: false, value: null };
}

function requiresState(countryCode) {
  return !NO_STATE_COUNTRIES.has(String(countryCode || '').toUpperCase());
}

/**
 * Validate a postal code against its country. Returns true when the country has
 * no enforced pattern — an unknown format is not the same as a wrong one.
 */
function isValidPostalCode(postalCode, countryCode) {
  const pattern = POSTAL_PATTERNS[String(countryCode || '').toUpperCase()];
  if (!pattern) return true;
  return pattern.test(String(postalCode || '').trim());
}

/** Only enforced for the US, where the two-letter code set is unambiguous. */
function isValidState(state, countryCode) {
  if (String(countryCode || '').toUpperCase() !== 'US') return true;
  return US_STATES.has(String(state || '').trim().toUpperCase());
}

module.exports = {
  ISO_ALPHA2,
  NO_STATE_COUNTRIES,
  POSTAL_PATTERNS,
  US_STATES,
  US_STATE_NAMES,
  isValidCountryCode,
  requiresState,
  isValidPostalCode,
  isValidState,
  normalizeState,
};
