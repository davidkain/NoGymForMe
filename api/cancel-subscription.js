/**
 * POST /api/cancel-subscription   (Vercel Serverless Function)
 *
 * Members-area "cancel my VIP subscription" action. Routes the request to the
 * Apps Script `vipCancel` handler, which applies the 90-day-journey settle-up
 * logic (VIP-BILLING-SPEC.md). In Safe Mode the handler records the outcome and
 * emails the operator to act manually — no real money moves.
 *
 * Server-mediated (not a direct browser → Apps Script call) on purpose, so we
 * can add the SUMIT recurring-order cancellation and a stronger ownership check
 * here before leaving Safe Mode.
 *
 * ⚠️ AUTH: today this trusts the email the members area already verified
 * (email-only gate). That is acceptable for Safe Mode (the handler only records
 * + emails). BEFORE enabling real charges, gate this with proof of ownership
 * (an emailed OTP / confirm-link), because a money action must not be
 * triggerable just by knowing someone else's email.
 *
 * ⚠️ SUMIT standing order: `vipCancel` computes the settle-up but does NOT stop
 * future monthly charges in SUMIT. In Safe Mode the operator cancels the
 * recurring order manually (they get the email). The LIVE TODO below marks where
 * the SUMIT recurring-cancel call goes once we wire it.
 */

'use strict';

const TRACKING_WEBAPP_URL = process.env.TRACKING_WEBAPP_URL ||
  'https://script.google.com/macros/s/AKfycbwBmCaPLs3cFn2zvJw4vuMoFypgigvDIJbPuLxnLTebWOISz5o892F_H0gLtBtFvfn5/exec';

// Asia/Jerusalem calendar date (YYYY-MM-DD) — stable idempotency key component.
function todayStamp() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
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

  // Deterministic idempotency key: repeated clicks on the same day collapse to a
  // single cancellation (the Apps Script ledger dedupes on cancelTxnId).
  const cancelTxnId = `cancel-${email}-${todayStamp()}`;

  try {
    const r = await fetch(TRACKING_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight
      body: JSON.stringify({ type: 'vipCancel', email, cancelTxnId }),
    });
    const data = await r.json().catch(() => null);

    if (!data || !data.ok) {
      const err = (data && data.error) || 'cancel failed';
      const notFound = /not found/i.test(err);  // email has no VIP subscription
      return res.status(notFound ? 404 : 502).json({ ok: false, error: err, notFound });
    }

    // ── LIVE TODO (after Safe Mode) ────────────────────────────────────────
    // Cancel the SUMIT recurring/standing order here so no further monthly
    // charges occur — POST to SUMIT's recurring-cancel endpoint with
    // { Credentials, ...standing-order id stored at signup }. Until then the
    // operator stops it manually from the email vipCancel sends.

    // Don't leak the internal settle-up numbers to the browser; the customer
    // gets the itemized details by email from the handler.
    const branch = data.result && data.result.branch;
    return res.status(200).json({ ok: true, branch: branch || null });
  } catch (err) {
    console.error('[cancel-subscription] tracking call failed:', err);
    return res.status(502).json({ ok: false, error: 'unreachable' });
  }
};
