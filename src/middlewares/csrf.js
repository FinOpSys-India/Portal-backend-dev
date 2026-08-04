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
 * Skipped entirely when the request carries a Bearer token: that request is not
 * cookie-authenticated, so CSRF does not apply to it.
 */
function requireCsrf(req, res, next) {
  if (!config.security.csrfEnabled) return next();
  if (SAFE_METHODS.has(req.method)) return next();

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

module.exports = { requireCsrf, issueCsrfToken };
