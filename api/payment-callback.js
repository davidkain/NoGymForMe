/**
 * GET /api/payment-callback   (Vercel Serverless Function)
 *
 * SUMIT redirects the customer here after the hosted payment page, appending
 * OG-PaymentID (+ OG-DocumentID). We VERIFY the payment server-to-server with
 * SUMIT — never trusting the redirect alone — and only then mark any discount
 * code used. Finally we send the customer on to the thank-you page.
 *
 * This is the SINGLE-USE enforcement point: a code is marked used ONLY after a
 * confirmed payment, so a declined or abandoned checkout never burns the code.
 *
 * Confirmation contract (from SUMIT's own WooCommerce gateway):
 *   POST https://api.sumit.co.il/billing/payments/get/  { Credentials, PaymentID }
 *   → response.Data.Payment.ValidPayment === true  means the payment succeeded.
 */

'use strict';

const SUMIT_PAYMENT_GET = 'https://api.sumit.co.il/billing/payments/get/';

const TRACKING_WEBAPP_URL = process.env.TRACKING_WEBAPP_URL ||
  'https://script.google.com/macros/s/AKfycbwBmCaPLs3cFn2zvJw4vuMoFypgigvDIJbPuLxnLTebWOISz5o892F_H0gLtBtFvfn5/exec';

function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader('Location', url);
  res.end();
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const planKey   = String(q.plan || '');
  const code      = String(q.code || '');
  const email     = String(q.email || '');
  // SUMIT appends these to our RedirectURL after payment.
  const paymentId = q['OG-PaymentID'] || q['og-paymentid'] || q.OGPaymentID || '';

  const origin = process.env.SITE_URL || `https://${req.headers.host}`;
  const thankYou = (paid) =>
    `${origin}/thank-you.html?plan=${encodeURIComponent(planKey)}&paid=${paid}`;

  // No payment id → nothing to verify (direct hit or cancelled). Send to the
  // thank-you page marked unpaid so it does NOT fire a Purchase event.
  if (!paymentId) return redirect(res, thankYou('0'));

  // ── Verify the payment with SUMIT ──────────────────────────────────────
  const companyIdRaw = process.env.SUMIT_COMPANY_ID;
  const apiKey       = process.env.SUMIT_API_KEY;
  let valid = false;
  if (companyIdRaw && apiKey) {
    const CompanyID = /^\d+$/.test(companyIdRaw) ? Number(companyIdRaw) : companyIdRaw;
    try {
      const r = await fetch(SUMIT_PAYMENT_GET, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Credentials: { CompanyID, APIKey: apiKey }, PaymentID: paymentId }),
      });
      const data = await r.json().catch(() => null);
      const payment = data && data.Data && data.Data.Payment;
      valid = !!(payment && payment.ValidPayment === true);
      if (!valid) console.error('[payment-callback] payment not valid:', JSON.stringify(payment));
    } catch (err) {
      console.error('[payment-callback] SUMIT verify failed:', err);
    }
  } else {
    console.error('[payment-callback] Missing SUMIT_COMPANY_ID / SUMIT_API_KEY');
  }

  // Mark the discount code used ONLY on a confirmed payment. Best-effort: never
  // block the customer's redirect if this call fails (log for reconciliation).
  if (valid && code) {
    try {
      await fetch(TRACKING_WEBAPP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ type: 'markUsed', code, email, paymentId: String(paymentId) }),
      });
    } catch (err) {
      console.error('[payment-callback] markUsed failed (code NOT marked):', code, err);
    }
  }

  if (!valid) return redirect(res, thankYou('0'));
  // disc=1 lets the thank-you page report the discounted value to the pixel.
  return redirect(res, thankYou('1') + (code ? '&disc=1' : ''));
};
