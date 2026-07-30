'use strict';

const crypto = require('crypto');

/**
 * Attach a request id to every request and echo it in the `X-Request-Id`
 * response header. It is included in error responses and log lines so a client
 * can quote it and an operator can find the matching backend logs — without any
 * sensitive data crossing that boundary.
 *
 * An inbound `X-Request-Id` is honoured (so a trace id set by an upstream proxy
 * flows through) but sanitised to a short opaque token to avoid header
 * injection or unbounded values.
 */
module.exports = function requestId(req, res, next) {
  const inbound = req.headers['x-request-id'];
  const clean = typeof inbound === 'string' ? inbound.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) : '';
  req.id = clean || `req_${crypto.randomBytes(8).toString('hex')}`;
  res.setHeader('X-Request-Id', req.id);
  next();
};
