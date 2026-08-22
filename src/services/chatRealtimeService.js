'use strict';

const jwt = require('jsonwebtoken');

const config = require('../config');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

/**
 * The bridge that lets a browser open a LIVE chat connection.
 *
 * WHY THIS API DOES NOT CARRY THE LIVE CONNECTION ITSELF
 * -----------------------------------------------------
 * It is deployed to Vercel as serverless functions with a 10-second ceiling per
 * request (vercel.json), so it cannot hold a WebSocket or an SSE stream open —
 * the connection would be cut mid-conversation every ten seconds, every time.
 * services/realtimeService, the admin SSE channel, works only because the place
 * it is used is a long-running local process.
 *
 * Supabase Realtime already holds those sockets and already reads the Postgres
 * replication stream. So the browser subscribes to it DIRECTLY:
 *
 *   POST /chat/.../messages  ->  Postgres WAL  ->  Supabase Realtime  ->  the
 *   other side's screen, with no refresh, no polling, and this API nowhere in
 *   the live path.
 *
 * WHAT IS LEFT FOR THIS FILE is the one thing Supabase cannot work out on its
 * own: WHO is connecting. This application signs its own JWTs and does not use
 * Supabase Auth, so a socket opened with the publishable key alone arrives
 * anonymous, and the RLS policies in db/schema/21_add_chat_realtime.sql would
 * correctly show it nothing at all.
 *
 * THE TOKEN THIS MINTS GRANTS STRICTLY LESS THAN AN ACCESS TOKEN
 * --------------------------------------------------------------
 * It is signed with the SUPABASE project secret, not this API's JWT_SECRET, so
 * it opens nothing here — no endpoint in this service will accept it, because
 * requireAuth verifies against a different key entirely. On the Supabase side it
 * is bounded by RLS: SELECT policies exist on the three chat tables and there is
 * no INSERT, UPDATE or DELETE policy anywhere, so a holder can watch their own
 * threads and can write nothing. Every write stays behind this API, where the
 * company-scope check lives.
 *
 * That is also why the two secrets must never be the same value. One secret
 * signing both would make a chat socket token a valid access token for every
 * endpoint in this API.
 */

/**
 * The claim the RLS policies read.
 *
 * NOT `sub`, which is where a user id would normally go — and this is worth
 * spelling out, because it looks like a mistake. Supabase's `auth.uid()` reads
 * `sub` and casts it to UUID; our users are INTEGER rows in our own `users`
 * table, so that cast fails and every policy using it errors rather than
 * denying. The policies therefore read a custom claim, and
 * public.chat_current_user_id() in db/schema/21_add_chat_realtime.sql is the one
 * place that name appears on the database side.
 */
const USER_ID_CLAIM = 'app_user_id';

/** Realtime rejects a token whose `role` is not one Supabase knows. */
const SUPABASE_ROLE = 'authenticated';

function liveChatUnavailable() {
  logger.error(
    'Live chat is not configured: SUPABASE_JWT_SECRET is required to sign realtime tokens. ' +
      'Chat itself keeps working over REST; only the live updates are off.'
  );

  return new ApiError(503, 'Live chat is not available right now.', {
    code: 'REALTIME_UNAVAILABLE',
  });
}

/**
 * Mint a short-lived Supabase token for one already-authenticated user.
 *
 * The user id comes from the VERIFIED access token (req.user.id), never from the
 * request — the whole security of the live feed rests on this claim being one
 * this server put there, since it is what every RLS policy filters on.
 *
 * @param {{ userId: number }} params
 * @returns {{ token: string, expiresInSeconds: number, url: string, userId: number }}
 */
function issueRealtimeToken({ userId }) {
  const secret = config.realtime.supabaseJwtSecret;
  if (!secret) throw liveChatUnavailable();

  const expiresInSeconds = config.realtime.tokenTtlSeconds;

  const token = jwt.sign(
    {
      [USER_ID_CLAIM]: userId,
      role: SUPABASE_ROLE,
      /*
       * `sub` is set to the same id as a string. Nothing reads it — the policies
       * use the claim above — but Realtime and PostgREST both expect a subject
       * on a token that claims to be an authenticated user, and a token without
       * one is refused before any policy runs.
       */
      sub: String(userId),
    },
    secret,
    {
      algorithm: 'HS256',
      expiresIn: expiresInSeconds,
      // Supabase verifies this audience on any token it accepts as a signed-in
      // user. It is not optional.
      audience: SUPABASE_ROLE,
    }
  );

  return {
    token,
    expiresInSeconds,
    /*
     * The project URL, echoed so the client has everything it needs from one
     * call. Not a secret — it is in every browser request the frontend already
     * makes, and it is the same value the frontend carries as
     * NEXT_PUBLIC_SUPABASE_URL. The SERVICE ROLE key is of course never returned
     * here; the browser pairs this token with its own publishable key.
     */
    url: config.storage.url || null,
    userId,
  };
}

module.exports = {
  USER_ID_CLAIM,
  issueRealtimeToken,
};
