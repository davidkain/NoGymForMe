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
 * ⚠️ Before going live, verify a shared secret / signature from SUMIT here so
 * only SUMIT can post cycles (a forged cycle would inflate the clawback later).
 */

'use strict';

const TRACKING_WEBAPP_URL = process.env.TRACKING_WEBAPP_URL ||
  'https://script.google.com/macros/s/AKfycbwBmCaPLs3cFn2zvJw4vuMoFypgigvDIJbPuLxnLTebWOISz5o892F_H0gLtBtFvfn5/exec';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
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
