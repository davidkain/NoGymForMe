/**
 * POST /api/summit-webhook   (Vercel Serverless Function)
 *
 * Receiver for SUMIT recurring-payment webhooks. SUMIT posts its OWN JSON shape
 * here; the Apps Script web app dispatches on a `type` field, so we tag the
 * payload as `summitWebhook` and forward it. The Apps Script handler then
 * records a VIP cycle (idempotent on the payment ref) and — for any payload it
 * can't match to a subscriber — emails the operator the raw body. That email is
 * how we capture the EXACT field names and lock the mapping in handleSummitWebhook_.
 *
 * Setup: point your SUMIT webhook / payment-notification URL at
 *   https://<your-site>/api/summit-webhook
 *
 * SECURITY: a shared secret gates this endpoint, but ONLY once you set the
 * SUMIT_WEBHOOK_SECRET env var (so it can't break the initial capture test).
 * After you set it, the SUMIT webhook URL must carry a matching `?key=<secret>`
 * (or an `X-Webhook-Secret` header) or the POST is rejected 401 — this stops a
 * forged cycle from inflating a future clawback.
 */

'use strict';

const TRACKING_WEBAPP_URL = process.env.TRACKING_WEBAPP_URL ||
  'https://script.google.com/macros/s/AKfycbwBmCaPLs3cFn2zvJw4vuMoFypgigvDIJbPuLxnLTebWOISz5o892F_H0gLtBtFvfn5/exec';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Shared-secret gate — env-gated so it never breaks the initial capture test.
  // Once SUMIT_WEBHOOK_SECRET is set, the SUMIT webhook URL must carry a matching
  // ?key=<secret> (or an X-Webhook-Secret header). Until then, POSTs are accepted.
  const secret = process.env.SUMIT_WEBHOOK_SECRET;
  if (secret) {
    const provided = (req.query && req.query.key) || req.headers['x-webhook-secret'] || '';
    if (provided !== secret) {
      console.error('[summit-webhook] rejected: bad/missing secret');
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  const payload = req.body || {};

  // Log the raw SUMIT payload to Vercel logs so the exact field names can be
  // confirmed and the Apps Script mapping tightened after the first real event.
  console.error('[summit-webhook] raw payload:', JSON.stringify(payload).slice(0, 2000));

  try {
    await fetch(TRACKING_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      // Merge our routing key in front; SUMIT's own fields pass through to
      // handleSummitWebhook_ (Customer / PaymentID / status, etc.).
      body: JSON.stringify(Object.assign({ type: 'summitWebhook' }, payload)),
    });
  } catch (err) {
    console.error('[summit-webhook] forward to Apps Script failed:', err);
  }

  // Always ACK 200 so SUMIT doesn't retry-storm — we've logged + forwarded.
  return res.status(200).json({ ok: true });
};
