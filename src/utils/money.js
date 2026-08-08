'use strict';

/**
 * Minor-unit money helpers.
 *
 * Every amount that is added, multiplied, or compared in the billing flow is an
 * INTEGER number of minor units (cents), never a float and never a decimal
 * string. $195.00 is 19500. That is also how Stripe reports `unit_amount`, so
 * our arithmetic and Stripe's agree exactly and no rounding step exists that
 * could disagree with the invoice.
 *
 * The catalog stores amounts as NUMERIC(18,2) — a display cache, in major units.
 * `decimalToMinor` converts that to minor units WITHOUT going through a binary
 * float, by parsing the digits either side of the decimal point.
 */

/**
 * Currencies whose smallest unit is not 1/100. Stripe's zero-decimal list plus
 * the three-decimal ones; anything not named here is assumed to have 2.
 * https://docs.stripe.com/currencies#special-cases
 */
const EXPONENTS = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, JPY: 0, KMF: 0, KRW: 0, MGA: 0,
  PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, OMR: 3, TND: 3,
};

/** How many minor units make one major unit of `currency`. */
function minorUnitExponent(currency) {
  const code = String(currency || '').toUpperCase();
  return Object.prototype.hasOwnProperty.call(EXPONENTS, code) ? EXPONENTS[code] : 2;
}

/**
 * Convert a decimal major-unit amount ("249.00", a Prisma Decimal, or a number)
 * to an integer number of minor units for `currency`.
 *
 * Parsed as text rather than multiplied as a float: `249.00 * 100` is 24999.99…
 * on some inputs, and a cent lost here is a cent that disagrees with Stripe.
 *
 * @returns {number} integer minor units
 */
function decimalToMinor(value, currency) {
  const exponent = minorUnitExponent(currency);
  const raw = String(value ?? '0').trim();

  const match = raw.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new TypeError(`Cannot convert "${raw}" to minor units.`);

  const [, sign, whole, fractionRaw = ''] = match;
  // Pad or truncate the fraction to exactly `exponent` digits.
  const fraction = fractionRaw.padEnd(exponent, '0').slice(0, exponent);
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
  const amount = Number(digits);

  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`Amount "${raw}" is out of range for safe integer arithmetic.`);
  }
  return sign === '-' ? -amount : amount;
}

/**
 * Render integer minor units back to a fixed-precision major-unit STRING, for
 * the Decimal columns (`unit_amount`, `amount_paid`). String, not number, so the
 * value reaches Prisma's Decimal without a float in between.
 */
function minorToDecimalString(minor, currency) {
  const exponent = minorUnitExponent(currency);
  const negative = minor < 0;
  const digits = String(Math.abs(Math.trunc(minor))).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent ? `.${digits.slice(digits.length - exponent)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** unit price x quantity, in minor units, with an overflow guard. */
function multiply(unitMinor, quantity) {
  const total = unitMinor * quantity;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError('Line total is out of range for safe integer arithmetic.');
  }
  return total;
}

module.exports = { minorUnitExponent, decimalToMinor, minorToDecimalString, multiply };
