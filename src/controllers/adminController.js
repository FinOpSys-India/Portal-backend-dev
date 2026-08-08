'use strict';

const asyncHandler = require('../middlewares/asyncHandler');
const logger = require('../utils/logger');
const { logEvent } = require('../utils/auditLog');
const realtime = require('../services/realtimeService');

/**
 * HTTP layer for the Admin area's real-time channel.
 *
 * The admin READS (companies + their accounting managers + the eligible manager
 * list) and the admin WRITES (assign / replace / remove) are not here: they are
 * company operations and live with the rest of the company flows in
 * companyController, behind the ADMIN gate. What is specific to "admin" as an
 * area — and therefore lives here — is the event stream those screens listen on.
 */

/**
 * POST /admin/events/ticket
 *
 * Exchange a bearer token for a short-lived, single-use ticket that opens the
 * event stream. Needed only by clients using `EventSource`, which cannot send an
 * Authorization header; anything that can set headers should call GET
 * /admin/events directly with its bearer token and skip this.
 */
const createStreamTicket = asyncHandler(async (req, res) => {
  const { ticket, expiresInSeconds } = realtime.issueStreamTicket(req.user.id);

  logEvent({ event: 'admin.stream.ticket_issued', status: 'success', requestId: req.id, userId: req.user.id });

  return res.status(201).json({
    success: true,
    message: 'Stream ticket issued.',
    data: {
      ticket,
      expiresInSeconds,
      // Spelled out so the client does not have to assemble the URL from parts
      // and get the parameter name wrong.
      streamPath: '/admin/events',
    },
  });
});

/**
 * GET /admin/events — Server-Sent Events.
 *
 * Authentication and the ADMIN check have already happened in
 * requireAdminStream. From here the response is a stream, not a document: it
 * stays open, carries events as they are published, and is closed by the client.
 *
 * Three headers earn their place. `Cache-Control: no-cache, no-transform` and
 * `X-Accel-Buffering: no` stop an intermediary from buffering the body — a proxy
 * holding 4KB before forwarding turns a real-time channel into a batch one — and
 * `flushHeaders()` sends the response head immediately, so the client's `onopen`
 * fires now rather than at the first event.
 */
const streamEvents = asyncHandler(async (req, res) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Node's default socket timeout would close a healthy idle stream.
  req.socket?.setTimeout?.(0);
  req.socket?.setNoDelay?.(true);
  req.socket?.setKeepAlive?.(true);

  /*
   * Tell the browser how long to wait before reconnecting, and say hello.
   *
   * The hello frame is not decoration: it is the client's cue that the channel
   * is live and — after a disconnection — that it is time to reload the
   * authoritative page data. Events published while the connection was down are
   * NOT replayed (no server-side buffer, deliberately: a buffer that can fall
   * behind is a second source of truth), so a refetch is how the client
   * recovers, and this frame is what tells it to.
   */
  res.write('retry: 3000\n\n');
  res.write(
    `event: ready\ndata: ${JSON.stringify({
      channel: realtime.ADMIN_CHANNEL,
      userId: req.user.id,
      serverTime: new Date().toISOString(),
      heartbeatSeconds: realtime.HEARTBEAT_MS / 1000,
      // Say it explicitly rather than leaving the client to infer the contract.
      reloadOnConnect: true,
    })}\n\n`
  );

  const unsubscribe = realtime.subscribe(res, { userId: req.user.id });
  logEvent({ event: 'admin.stream.opened', status: 'success', requestId: req.id, userId: req.user.id });

  const close = () => {
    unsubscribe();
    logEvent({ event: 'admin.stream.closed', status: 'success', requestId: req.id, userId: req.user.id });
  };

  // 'close' covers the client going away, the socket dying, and the server
  // shutting the connection; it fires exactly once.
  res.on('close', close);
  res.on('error', (err) => {
    logger.warn(`[${req.id}] Admin stream error for user ${req.user.id}: ${err.message}`);
  });
});

module.exports = { createStreamTicket, streamEvents };
