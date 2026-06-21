/**
 * POST /api/meta-capi-purchase   (Vercel Serverless Function, Node.js)
 *
 * Thin HTTP wrapper over lib/meta-capi.js. Sends a server-side "Purchase" event
 * to the Meta Conversions API (CAPI). Two callers use this endpoint:
 *   - thank-you.html — FALLBACK browser call, only when the server-side trigger
 *     in api/payment-callback.js didn't already fire (see its `capi=1` flag).
 *   - any future checkout-success webhook that wants to report a purchase.
 *
 * The primary, most reliable Purchase is sent server-to-server from
 * api/payment-callback.js (where the payment is verified and the email is
 * known) — NOT from here. Both share an `event_id` so Meta deduplicates them.
 *
 * RELIABILITY: a Meta outage/timeout is logged inside lib/meta-capi.js and never
 * throws, so this route always resolves with HTTP 200 (+ an { ok } flag), except
 * for a malformed request (400) or a wrong method (405).
 */

'use strict';

const { sendPurchaseEvent } = require('../lib/meta-capi');

// Pull the real client IP from Vercel's proxy chain (first hop = the user).
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket && req.socket.remoteAddress;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Vercel auto-parses application/json into req.body.
  const body = req.body || {};

  // Order value is the one field we genuinely need. Reject if it's not a
  // positive number — a Purchase with no value is useless for optimisation.
  const value = Number(body.value);
  if (!Number.isFinite(value) || value <= 0) {
    return res.status(400).json({ ok: false, error: 'Missing or invalid `value`' });
  }

  // Hand off to the shared sender. It hashes PII, builds the payload, applies a
  // timeout and swallows Meta failures — returning a plain result object.
  const result = await sendPurchaseEvent({
    value,
    currency: body.currency,
    email: body.email,
    phone: body.phone,
    firstName: body.first_name || body.firstName,
    lastName: body.last_name || body.lastName,
    fbp: body.fbp,
    fbc: body.fbc,
    clientIp: clientIp(req),
    userAgent: req.headers['user-agent'],
    eventId: body.event_id,
    eventSourceUrl: body.event_source_url || req.headers.referer,
    orderId: body.order_id,
    quantity: body.quantity,
    testEventCode: body.test_event_code,
  });

  // Always 200 so a tracking failure never surfaces as an error to the caller
  // (the browser fire-and-forgets this anyway). The { ok } flag carries status.
  return res.status(200).json(result);
};
