'use strict';

const crypto = require('crypto');

const config = require('../config');
const ApiError = require('../utils/ApiError');

/**
 * Double-submit CSRF protection for cookie-authenticated requests.
 *
 * Why this is needed at all: the refresh token lives in an HttpOnly cookie, and
 * a browser attaches cookies to cross-site requests automatically. `SameSite=Lax`
 * blocks the obvious cases but is a mitigation, not a guarantee — it does not
 * cover every navigation, it is applied inconsistently by older browsers, and it
 * says nothing about a same-site subdomain that an attacker controls. Any
 * endpoint that acts on the cookie alone (POST /auth/refresh, /auth/logout) is
 * therefore forgeable without this.
 *
 * How the double-submit pattern works: the server sets a random token in a
 * READABLE cookie, and the client must echo it back in a header. An attacker on
 * another origin can cause the cookie to be SENT, but the same-origin policy
 * stops them READING it, so they cannot produce the matching header.
 *
 * Deliberately NOT applied to:
 *   - Bearer-authenticated requests. A token the client has to attach by hand is
 *     not attached automatically by the browser, so there is nothing to forge.
 *     Requiring a CSRF header there would be ceremony without a threat.
 *   - The Stripe webhook. Stripe is not a browser, holds no cookie, and
 *     authenticates by signature.
 *   - Safe methods (GET/HEAD/OPTIONS), which must not change state anyway.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TOKEN_BYTES = 32;

/*
 * Endpoints that establish a credential rather than act on one, matched against
 * the path RELATIVE to the API prefix (this middleware is mounted on the prefix,
 * so `/api/auth/login` arrives here as `/auth/login`).
 *
 * These authenticate from the request BODY — an email and password, an OTP, a
 * reset ticket — so nothing about them is forgeable by a browser attaching a
 * cookie on its own, which is the only thing CSRF defends against. They are
 * exempt because the gate would otherwise lock people out for real: a returning
 * visitor can easily be holding a stale `refreshToken` cookie without a matching
 * CSRF cookie (the CSRF cookie is readable by design, so an extension or a
 * partial cookie clear can remove just that one), and the check keys off the
 * presence of the refresh cookie. Gating login on it would answer 403 to exactly
 * the request that would have repaired the situation.
 *
 * Login CSRF — forcing a victim's browser to sign in as the attacker — is the
 * residual risk, and it is accepted here: it does not expose the victim's data,
 * and the endpoints below all rotate the session cookie anyway.
 */
const CSRF_EXEMPT_PATHS = new Set([
  '/auth/login',
  '/auth/signup',
  '/auth/otp',
  '/auth/password-reset',
  '/auth/password-reset/otp',
  '/auth/password-reset/confirm',
  // Stripe is not a browser: it holds no cookie and authenticates by signature.
  // Its router is mounted ahead of the body parsers so it never actually reaches
  // this gate, but naming it here keeps that true if the mount order changes.
  '/billing/webhook',
]);

// Trailing slashes and casing must not be a way around the list above.
function normalizePath(path) {
  const lowered = String(path || '/').toLowerCase();
  return lowered.length > 1 ? lowered.replace(/\/+$/, '') : lowered;
}

/**
 * Mint a token and set it in a readable (NOT HttpOnly) cookie.
 *
 * `expiresAt` must be the refresh cookie's own expiry, so the two live and die
 * together. It previously took no expiry at all, which made this a SESSION
 * cookie: it was discarded when the browser closed, while the refresh cookie
 * survived for its full 30 days. The next visit therefore arrived holding a
 * valid session cookie and no CSRF token — which requireCsrf (below) does not
 * skip, since the refresh cookie is present — so the client's opening
 * POST /auth/refresh answered 403 and every returning user was bounced to the
 * login screen despite having a live session.
 *
 * Omitting it still yields a session cookie, for a caller that genuinely wants
 * one; every caller here passes the refresh expiry.
 */
function issueCsrfToken(res, expiresAt) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  res.cookie(config.security.csrfCookieName, token, {
    // Readable by page JavaScript on purpose — that is the whole mechanism.
    httpOnly: false,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
    ...(expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime())
      ? { expires: expiresAt }
      : {}),
  });
  return token;
}

/**
 * Constant-time comparison. A short-circuiting `===` on a secret leaks how many
 * leading characters matched, which over enough requests is enough to recover it.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Guard a state-changing route that authenticates from a cookie.
 *
 * Mounted GLOBALLY on the API prefix (see app.js) rather than listed per route.
 * It was previously opt-in, attached by hand to /auth/refresh and /auth/logout —
 * the only two cookie-authenticated endpoints at the time. That was correct on
 * the day it was written and silently wrong the moment anyone added a third:
 * a route that reads the refresh cookie and forgets the middleware is
 * unprotected, and nothing fails to tell you. A default-on gate inverts that —
 * a new route is covered unless someone deliberately exempts it.
 *
 * Skipped entirely when the request carries a Bearer token: that request is not
 * cookie-authenticated, so CSRF does not apply to it.
 */
function requireCsrf(req, res, next) {
  if (!config.security.csrfEnabled) return next();
  if (SAFE_METHODS.has(req.method)) return next();
  if (CSRF_EXEMPT_PATHS.has(normalizePath(req.path))) return next();

  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) return next();

  /*
   * No refresh cookie means this request is not cookie-authenticated: whatever
   * credential it carries was attached deliberately, in the body or a header,
   * which is precisely what a cross-site attacker cannot do. CSRF is about the
   * browser attaching a credential BY ITSELF, so with no ambient credential
   * there is nothing to protect — and demanding a token here would lock out
   * every non-browser client (a mobile app, a server-side integration) that has
   * no cookie jar to hold one in.
   */
  if (!req.cookies?.refreshToken) return next();

  const cookieToken = req.cookies?.[config.security.csrfCookieName];
  const headerToken = req.headers[config.security.csrfHeaderName];

  if (!cookieToken || !headerToken || !safeEqual(cookieToken, Array.isArray(headerToken) ? headerToken[0] : headerToken)) {
    return next(
      new ApiError(403, 'Missing or invalid CSRF token.', {
        code: 'CSRF_TOKEN_INVALID',
        details: {
          cookieName: config.security.csrfCookieName,
          headerName: config.security.csrfHeaderName,
        },
      })
    );
  }

  return next();
}

module.exports = { requireCsrf, issueCsrfToken, CSRF_EXEMPT_PATHS };
