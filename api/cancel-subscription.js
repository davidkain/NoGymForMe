/**
 * POST /api/cancel-subscription   (Vercel Serverless Function)
 *
 * Members-area "cancel my VIP subscription" action — two steps, to prove the
 * requester controls the email before any settle-up:
 *   1) POST { email }          → Apps Script emails a 6-digit code (vipCancelRequestOtp)
 *   2) POST { email, otp }      → Apps Script verifies the code + runs vipCancel
 *
 * vipCancel applies the 90-day-journey settle-up logic (VIP-BILLING-SPEC.md). In
 * Safe Mode it records the outcome and emails the operator to act manually — no
 * money moves automatically until the SUMIT_* Script Properties are set.
 *
 * Server-mediated (not a direct browser → Apps Script call) so the SUMIT
 * recurring-order cancellation can live here too.
 *
 * ⚠️ SUMIT standing order: vipCancel computes the settle-up but does NOT stop
 * future monthly charges in SUMIT. In Safe Mode the operator cancels the
 * recurring order manually (they get the email). The LIVE TODO below marks where
 * the SUMIT recurring-cancel call goes once its API + the standing-order id
 * (captured at signup) are confirmed from a real payment payload.
 */

'use strict';

const TRACKING_WEBAPP_URL = process.env.TRACKING_WEBAPP_URL ||
  'https://script.google.com/macros/s/AKfycbwBmCaPLs3cFn2zvJw4vuMoFypgigvDIJbPuLxnLTebWOISz5o892F_H0gLtBtFvfn5/exec';

// Asia/Jerusalem calendar date (YYYY-MM-DD) — stable idempotency key component.
function todayStamp() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

async function callAppsScript(payload) {
  const r = await fetch(TRACKING_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight
    body: JSON.stringify(payload),
  });
  return r.json().catch(() => null);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'invalid email' });
  }
  const otp = String(body.otp || '').trim();

  // ── Step 1: no code yet → ask Apps Script to email a one-time code. ────────
  if (!otp) {
    try {
      const data = await callAppsScript({ type: 'vipCancelRequestOtp', email });
      if (!data || !data.ok) {
        return res.status(502).json({ ok: false, error: 'otp_request_failed' });
      }
      // sent:false → no VIP subscription for this email (surface it to the UI).
      return res.status(200).json({ ok: true, stage: 'otp_sent', otpSent: !!data.sent });
    } catch (err) {
      console.error('[cancel-subscription] OTP request failed:', err);
      return res.status(502).json({ ok: false, error: 'unreachable' });
    }
  }

  // ── Step 2: code present → verify + run the settle-up. ────────────────────
  // Deterministic idempotency key: repeated confirms on the same day collapse to
  // one cancellation (the Apps Script ledger dedupes on cancelTxnId).
  const cancelTxnId = `cancel-${email}-${todayStamp()}`;
  try {
    const data = await callAppsScript({ type: 'vipCancel', email, otp, cancelTxnId });
    if (!data || !data.ok) {
      const err = (data && data.error) || 'cancel failed';
      const otpBad = err === 'otp_invalid' || err === 'otp_required';
      const notFound = /not found/i.test(err);
      const status = otpBad ? 401 : (notFound ? 404 : 502);
      return res.status(status).json({ ok: false, error: err, otpBad, notFound });
    }

    // ── LIVE TODO (after Safe Mode) ────────────────────────────────────────
    // Cancel the SUMIT recurring/standing order here so no further monthly
    // charges occur, using the standing-order id captured at signup. Until then
    // the operator stops it manually from the email vipCancel sends.

    const branch = data.result && data.result.branch;
    return res.status(200).json({ ok: true, stage: 'cancelled', branch: branch || null });
  } catch (err) {
    console.error('[cancel-subscription] cancel failed:', err);
    return res.status(502).json({ ok: false, error: 'unreachable' });
  }
};
