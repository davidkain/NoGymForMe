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

const { sendPurchaseEvent } = require('../lib/meta-capi');
const { sendCompletePaymentEvent } = require('../lib/tiktok-events');

// Plan → VAT-inclusive price (ILS) for the CAPI Purchase value. KEEP IN SYNC
// with PLANS in create-payment.js and PLAN_LABELS in thank-you.html.
const PLAN_PRICES = { single: 198, starter: 396, results: 496, subscription: 155 };
const { discountPercentFor } = require('../lib/discount-codes');

// Parse a Cookie header into a plain object so we can read the first-party
// _fbp / _fbc cookies the Meta Pixel set on this domain (better match quality).
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

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
  // Server-computed order total (already reflects any discount). Set by
  // create-payment.js for every order — the authoritative value for the
  // Meta CAPI Purchase, so a multi-item cart reports its real total.
  const amtRaw    = parseInt(q.amt, 10);
  const orderAmt  = Number.isFinite(amtRaw) && amtRaw > 0 ? amtRaw : null;
  // SUMIT appends these to our RedirectURL after payment.
  const paymentId = q['OG-PaymentID'] || q['og-paymentid'] || q.OGPaymentID || '';

  const origin = process.env.SITE_URL || `https://${req.headers.host}`;
  const thankYou = (paid) =>
    `${origin}/thank-you.html?plan=${encodeURIComponent(planKey)}&paid=${paid}` +
    (orderAmt != null ? `&amt=${orderAmt}` : '');

  // No payment id → nothing to verify (direct hit or cancelled). Send to the
  // thank-you page marked unpaid so it does NOT fire a Purchase event.
  if (!paymentId) return redirect(res, thankYou('0'));

  // ── Verify the payment with SUMIT ──────────────────────────────────────
  const companyIdRaw = process.env.SUMIT_COMPANY_ID;
  const apiKey       = process.env.SUMIT_API_KEY;
  let valid = false;
  let verifiedPayment = null;   // SUMIT Data.Payment — source of the VIP customer/method ids
  let verifiedData = null;      // SUMIT Data — fallback field paths
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
      verifiedData = data && data.Data;
      verifiedPayment = payment;
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

  // ── VIP subscription → register it for the 90-day-journey settle-up logic ──
  // Recurring plan only, on a CONFIRMED payment. Captures the SUMIT customer +
  // saved payment-method ids that apps-script.gs needs to charge an early-
  // cancellation settle-up. Best-effort: a failure here must NEVER block the
  // customer's redirect to thank-you.
  if (planKey === 'subscription') {
    try {
      const p = verifiedPayment || {};
      const cust = p.Customer || (verifiedData && verifiedData.Customer) || {};
      const method = p.PaymentMethod || (verifiedData && verifiedData.PaymentMethod) || {};
      const summitCustomerId = cust.ID || p.CustomerID || '';
      const summitPaymentId  = method.ID || p.PaymentMethodID || (verifiedData && verifiedData.PaymentMethodID) || '';
      await fetch(TRACKING_WEBAPP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          type: 'vipSubscribe',
          subId: `vip-${String(paymentId)}`,
          name:  cust.Name || '',
          email: email || cust.EmailAddress || '',
          phone: cust.Phone || '',
          summitCustomerId: String(summitCustomerId),
          summitPaymentId:  String(summitPaymentId),
          firstChargeDate:  new Date().toISOString().slice(0, 10),
        }),
      });
      // One-time visibility: dump the SUMIT payment shape (Vercel logs) so the
      // exact Customer / PaymentMethod field paths can be confirmed for THIS
      // account — same "show me the real payload" approach as summitWebhook.
      console.error('[payment-callback] vipSubscribe sent; SUMIT Data shape:',
        JSON.stringify(verifiedData || {}).slice(0, 1500));
    } catch (err) {
      console.error('[payment-callback] vipSubscribe failed:', err);
    }
  }

  // ── Server-side Meta CAPI Purchase (primary, most reliable signal) ─────────
  // Fire from here — the verified-payment point — so the conversion reaches Meta
  // even if the browser tab closes or an ad-blocker drops the Pixel. We mint the
  // event_id HERE and hand it to thank-you.html (?eid=) so the browser Pixel
  // reuses it and Meta DEDUPES the two reports into one conversion. We await it
  // (it self-limits to 5s and never throws) so the function doesn't freeze the
  // request before the event is sent.
  const eventId = `purchase_${String(paymentId)}`;
  let capiSent = false;
  // Prefer the server-computed order total (multi-item aware, discount already
  // applied). Fall back to the single-plan price table for older/direct links
  // that predate the &amt param. A single `code` value (never a list) was
  // forwarded from create-payment.js, so at most one discount was ever applied.
  const base = PLAN_PRICES[planKey];
  const value = orderAmt != null
    ? orderAmt
    : (base ? (code ? Math.round(base * (1 - discountPercentFor(code) / 100)) : base) : null);
  if (value != null) {
    const cookies = parseCookies(req.headers.cookie);
    const xff = req.headers['x-forwarded-for'];
    const clientIp = xff ? String(xff).split(',')[0].trim() : (req.socket && req.socket.remoteAddress);
    const userAgent = req.headers['user-agent'];
    // Meta and TikTok are fired in PARALLEL: each self-limits to 5s and never
    // throws, so running them in sequence would stack the timeouts and could
    // hold the customer on a blank redirect for 10s. Promise.all keeps the
    // worst case at 5s. Both reuse the SAME eventId, so each platform dedupes
    // its server event against its browser pixel event.
    const [result, ttResult] = await Promise.all([
      sendPurchaseEvent({
        value,
        currency: 'ILS',
        email,                                 // hashed inside; '' when we have none
        fbp: cookies._fbp,
        fbc: cookies._fbc,
        clientIp,
        userAgent,
        eventId,
        eventSourceUrl: thankYou('1'),
        orderId: String(paymentId),
      }),
      sendCompletePaymentEvent({
        value,
        currency: 'ILS',
        email,                                 // hashed inside; '' when we have none
        ttp: cookies._ttp,                     // TikTok browser id, set by the pixel
        ttclid: cookies.ttclid || cookies._ttclid,
        clientIp,
        userAgent,
        eventId,
        eventSourceUrl: thankYou('1'),
        orderId: String(paymentId),
      }),
    ]);
    capiSent = !!(result && result.ok);
    if (ttResult && !ttResult.ok && !ttResult.skipped) {
      console.error('[payment-callback] TikTok CompletePayment failed:', ttResult.error, ttResult.message || '');
    }
  } else {
    console.error('[payment-callback] No order amount/price — CAPI Purchase skipped. plan:', planKey, 'amt:', q.amt);
  }

  // ── Record the completed order server-side ────────────────────────────────
  // thank-you.html used to be the ONLY writer of the Completed Orders row: it
  // reads the order out of localStorage, which the SUMIT round-trip can destroy
  // (private mode, or the in-app browsers TikTok and Instagram open links in).
  // When that happened the money was taken, the Purchase pixel still fired off
  // the URL params — and the sale record AND the buyer's confirmation email were
  // silently lost, leaving the shopper's details sitting in the abandoned tab.
  //
  // So we write it HERE, at the verified-payment point, and tell thank-you.html
  // via &rec=1 to stand down. There must be exactly ONE writer: apps-script.gs
  // appends unconditionally and emails the buyer on every `completed`, with no
  // idempotency on the order number, so a second write means a duplicate row
  // AND a second confirmation email to the customer.
  //
  // Scoped deliberately to SINGLE-plan orders. For a multi-item cart the browser
  // is the better writer: it holds the per-item breakdown and the exact Hebrew
  // plan-summary string that downstream consumers (the tracker app's
  // /api/webhooks/orders) parse. `planKey` is 'multi' here and carries none of
  // that, so we leave those orders alone rather than change a contract that has
  // broken multi-quantity buyers before.
  let recorded = false;
  if (planKey && planKey !== 'multi' && value != null) {
    // SUMIT's response shape is not contractually pinned for this account, so
    // read the customer fields defensively across the paths it is known to use
    // (same approach as the vipSubscribe branch above). Whatever is missing is
    // simply omitted: the shipping address is always ALSO on the `started` row
    // that order.html wrote at submit time, and the Apps Script's
    // promoteAbandonedToCompleted() links that row to this order.
    const p = verifiedPayment || {};
    const cust = p.Customer || (verifiedData && verifiedData.Customer) || {};
    try {
      // Time-boxed: Apps Script can be slow, and this runs while the buyer is
      // sitting on a blank redirect. 4s then give up — the row matters, but not
      // more than getting the customer to their confirmation page.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch(TRACKING_WEBAPP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            type:     'completed',
            orderNum: String(paymentId),
            name:     cust.Name || '',
            email:    email || cust.EmailAddress || '',
            phone:    cust.Phone || '',
            address:  cust.Address || '',
            city:     cust.City || '',
            plan:     planKey,
            // Format must match thank-you.html byte for byte: apps-script.gs
            // renders `total` verbatim into the buyer's confirmation email
            // ('סכום'), so a bare number would show up there as "198".
            total:    '₪' + value + (planKey === 'subscription' ? '/חודש' : ''),
          }),
          signal: ctrl.signal,
        });
        const out = await r.json().catch(() => null);
        recorded = !!(r.ok && (!out || out.ok !== false));
      } finally {
        clearTimeout(timer);
      }
      if (!recorded) console.error('[payment-callback] completed-order write rejected for', paymentId);
      // One-time visibility: dump the customer shape so the real Address / City
      // field paths can be confirmed for THIS account and tightened above.
      console.error('[payment-callback] completed recorded=' + recorded + '; SUMIT Customer shape:',
        JSON.stringify(cust).slice(0, 800));
    } catch (err) {
      // Never block the redirect. thank-you.html stays the fallback writer
      // because we do NOT append rec=1 unless the row actually landed.
      console.error('[payment-callback] completed-order write failed:', err);
    }
  }

  // disc=1 lets the thank-you page report the discounted value to the pixel.
  // eid lets the browser Pixel reuse our event_id; capi=1 tells it the server
  // already sent the CAPI event, so it skips the browser fallback call.
  // rec=1 tells it the Completed Orders row is already written, so it skips its
  // own write and does not double-email the buyer.
  let dest = thankYou('1') + (code ? '&disc=1' : '');
  dest += `&eid=${encodeURIComponent(eventId)}`;
  if (capiSent) dest += '&capi=1';
  if (recorded) dest += '&rec=1';
  return redirect(res, dest);
};
