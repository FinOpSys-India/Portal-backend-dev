'use strict';

const crypto = require('crypto');

const logger = require('../utils/logger');

/**
 * Server-Sent Events fan-out for the Admin area.
 *
 * WHY SSE AND NOT WEBSOCKETS
 * --------------------------
 * This process serves JSON over Express and nothing else — no document, no
 * bidirectional protocol, no socket library in package.json. The only thing the
 * admin screens need is "tell me when something changed", which is one-way
 * server -> client. SSE is that, over the HTTP server already listening, with no
 * new dependency, no upgrade handshake, and the browser's own automatic
 * reconnect. A WebSocket would add a second protocol and a second auth path for
 * a channel that never carries a client message.
 *
 * WHAT IS PUBLISHED
 * -----------------
 * Only AFTER the database transaction that caused it has committed. Publishing
 * from inside a transaction would broadcast a change that a rollback then undoes,
 * and every listening admin would hold state the database never had. Each
 * publish site therefore sits after `await prisma.$transaction(...)` returns.
 *
 * Events are small and already-authorized shapes (the same DTOs the REST
 * endpoints return), never raw rows: a stream is just another response surface,
 * and a password hash leaked here is leaked exactly as badly as in a body.
 *
 * FUTURE — the subscriber registry is per-PROCESS, like the rate limiter's
 * in-memory store. Two instances behind a load balancer each notify only their
 * own connections. Before running more than one, put a shared bus in front of
 * `publish` (Postgres LISTEN/NOTIFY is the smallest step: the database is
 * already the thing every instance shares) and have each instance fan out to its
 * local subscribers from that.
 */

/** The one channel that exists today: authenticated ADMIN sessions. */
const ADMIN_CHANNEL = 'admin';

/** Live SSE connections. */
const subscribers = new Set();

/** Comment frames keep proxies from closing an idle stream. */
const HEARTBEAT_MS = 25_000;

/** How long a stream ticket is worth anything. Deliberately tiny. */
const TICKET_TTL_MS = 60_000;

/**
 * Single-use tickets that let `EventSource` open the stream.
 *
 * EventSource cannot send an Authorization header — that is a limitation of the
 * browser API, not a choice — so a stream opened by it has to carry its
 * credential somewhere the API can read. Putting the ACCESS TOKEN in the query
 * string is the usual answer and the wrong one: URLs are written to access logs,
 * proxy logs and Referer headers, and that token is good for every endpoint for
 * the rest of its TTL.
 *
 * So the client exchanges its bearer token for a ticket that is single-use, lives
 * for a minute, is bound to one user id, and grants exactly one thing: the right
 * to open this read-only stream. Leaking it costs nothing that expires slower
 * than a minute. Only the SHA-256 hash is kept, for the same reason refresh
 * tokens are stored hashed.
 *
 * A client that can set headers (fetch + ReadableStream) skips all of this and
 * sends `Authorization: Bearer` to the stream directly — see adminController.
 */
const tickets = new Map();

/** Monotonic per-process event id, echoed as the SSE `id:` field. */
let lastEventId = 0;

function hashTicket(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function pruneTickets(now = Date.now()) {
  for (const [key, value] of tickets) {
    if (value.expiresAt <= now) tickets.delete(key);
  }
}

/**
 * Mint a stream ticket for an already-authenticated admin.
 * @returns {{ ticket: string, expiresInSeconds: number }}
 */
function issueStreamTicket(userId) {
  pruneTickets();
  const raw = crypto.randomBytes(32).toString('hex');
  tickets.set(hashTicket(raw), { userId, expiresAt: Date.now() + TICKET_TTL_MS });
  return { ticket: raw, expiresInSeconds: TICKET_TTL_MS / 1000 };
}

/**
 * Redeem a ticket. Single-use: the entry is deleted whether or not it was still
 * valid, so a replay of the same value finds nothing.
 *
 * @returns {number|null} the user id it was minted for, or null.
 */
function consumeStreamTicket(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const key = hashTicket(raw);
  const entry = tickets.get(key);
  tickets.delete(key);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.userId;
}

/** Serialize one SSE frame. */
function frame({ id, event, data }) {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Register a live connection. The response must already carry the SSE headers.
 *
 * @param {import('http').ServerResponse} res
 * @param {{ userId: number, channel?: string }} context
 * @returns {() => void} unsubscribe
 */
function subscribe(res, { userId, channel = ADMIN_CHANNEL }) {
  const entry = { res, userId, channel };
  subscribers.add(entry);

  // `unref` so a live stream never holds the process open during shutdown.
  const heartbeat = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      // A dead socket surfaces on the next write; the 'close' handler below
      // does the actual cleanup.
    }
  }, HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  logger.info(`Realtime: ${channel} subscriber added (user ${userId}), ${subscribers.size} live.`);

  return function unsubscribe() {
    clearInterval(heartbeat);
    subscribers.delete(entry);
    logger.info(`Realtime: ${channel} subscriber removed (user ${userId}), ${subscribers.size} live.`);
  };
}

/**
 * Broadcast to every live subscriber on a channel.
 *
 * Never throws: a broken pipe on one admin's browser must not fail the request
 * that triggered the event — the write has already been committed, and the
 * client recovers by reloading after it reconnects.
 *
 * @param {string} event  Dotted event name, e.g. 'company.accounting_manager.assigned'.
 * @param {object} data   Already-shaped DTO. Never a raw database row.
 */
function publish(event, data, { channel = ADMIN_CHANNEL } = {}) {
  if (!subscribers.size) return 0;

  lastEventId += 1;
  const payload = frame({ id: lastEventId, event, data });

  let delivered = 0;
  for (const entry of subscribers) {
    if (entry.channel !== channel) continue;
    try {
      entry.res.write(payload);
      delivered += 1;
    } catch (err) {
      logger.warn(`Realtime: dropping subscriber (user ${entry.userId}): ${err.message}`);
      subscribers.delete(entry);
    }
  }
  return delivered;
}

/** Live connection count, for the stream's own hello frame and for tests. */
function subscriberCount(channel = ADMIN_CHANNEL) {
  let n = 0;
  for (const entry of subscribers) if (entry.channel === channel) n += 1;
  return n;
}

/** Test seam: drop every connection and ticket. */
function reset() {
  subscribers.clear();
  tickets.clear();
}

module.exports = {
  ADMIN_CHANNEL,
  HEARTBEAT_MS,
  TICKET_TTL_MS,
  issueStreamTicket,
  consumeStreamTicket,
  subscribe,
  publish,
  subscriberCount,
  reset,
};
