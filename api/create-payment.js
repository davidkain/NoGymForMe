/**
 * POST /api/create-payment   (Vercel Serverless Function, Node.js)
 *
 * Creates a SUMIT hosted payment page and returns its URL. This code runs ONLY
 * on the server — the SUMIT CompanyID + APIKey live in environment variables
 * and are never sent to the browser.
 *
 * SECURITY: the browser sends only a `plan` key. The PRICE is decided here,
 * server-side, from the PLANS table below. The client can never set its own
 * amount. Keep prices in sync with the display-only PLANS object in order.html.
 *
 * SUMIT contract (confirmed from SUMIT's WooCommerce gateway source):
 *   Endpoint : POST https://api.sumit.co.il/billing/payments/beginredirect/
 *   Auth     : body.Credentials = { CompanyID, APIKey }
 *   Success  : response.Status === 0 and response.Data.RedirectURL holds the
 *              hosted payment-page URL to send the customer to.
 *   Recurring: item-level Duration_Months + Recurrence (subscriptions).
 */

'use strict';

const SUMIT_BEGIN_REDIRECT = 'https://api.sumit.co.il/billing/payments/beginredirect/';

// Public Apps Script web-app URL (the same one tracking.js posts to) — used to
// validate discount codes server-side. Overridable via env if the deployed
// Apps Script URL ever changes.
const TRACKING_WEBAPP_URL = process.env.TRACKING_WEBAPP_URL ||
  'https://script.google.com/macros/s/AKfycbwBmCaPLs3cFn2zvJw4vuMoFypgigvDIJbPuLxnLTebWOISz5o892F_H0gLtBtFvfn5/exec';

const { discountPercentFor } = require('../lib/discount-codes');

// POST a JSON payload to the Apps Script web app and return its parsed JSON.
// text/plain avoids a CORS preflight (matches the browser tracking client).
async function callTracking(payload, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 6000);
  try {
    const r = await fetch(TRACKING_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Friendly Hebrew message for each discount-rejection reason.
function discountMessage(reason) {
  switch (reason) {
    case 'used':       return 'קוד ההנחה הזה כבר נוצל.';
    case 'wrongemail': return 'הקוד שייך לכתובת מייל אחרת — השתמש במייל שאיתו קיבלת את הקוד.';
    case 'notfound':   return 'קוד הנחה לא תקין.';
    case 'noemail':    return 'נדרש אימייל כדי להחיל קוד הנחה.';
    case 'unreachable':return 'לא הצלחנו לאמת את קוד ההנחה כרגע. נסה שוב או הסר את הקוד.';
    default:           return 'לא ניתן להחיל את קוד ההנחה.';
  }
}

// SOURCE OF TRUTH for what each plan costs. Prices are VAT-inclusive (ILS).
const PLANS = {
  single:       { name: 'חבילת הביישן',                      price: 198, qty: 1, recurring: false },
  starter:      { name: 'חבילת יאללה, בוא ננסה',             price: 396, qty: 1, recurring: false },
  results:      { name: 'חבילת אול-אין (כי הקיץ כבר פה...)', price: 496, qty: 1, recurring: false },
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Vercel auto-parses a JSON body into req.body for application/json requests.
  const body = req.body || {};
  const planKey = String(body.plan || '');
  const plan = PLANS[planKey];
  if (!plan) return res.status(400).json({ error: 'Unknown plan' });

  const companyIdRaw = process.env.SUMIT_COMPANY_ID;
  const apiKey       = process.env.SUMIT_API_KEY;
  if (!companyIdRaw || !apiKey) {
    // Don't leak which var is missing to the client.
    console.error('[create-payment] Missing SUMIT_COMPANY_ID and/or SUMIT_API_KEY');
    return res.status(500).json({ error: 'Payment is not configured yet' });
  }
  // SUMIT expects a numeric CompanyID when the value is numeric.
  const CompanyID = /^\d+$/.test(companyIdRaw) ? Number(companyIdRaw) : companyIdRaw;

  // Light, defensive normalization of customer fields (SUMIT also validates).
  const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const email = clean(body.email, 150);

  // ── Discount code (non-subscription only) ──────────────────────────────
  // Validated SERVER-SIDE: the code must belong to THIS email and be unused.
  // We do NOT mark it used here — that happens only after SUMIT confirms the
  // payment (api/payment-callback.js). On ANY failure we BLOCK with an error
  // so a customer is never charged full price while expecting a discount.
  const code = clean(body.code, 40).toUpperCase();
  let unitPrice = plan.price;
  let discountCode = '';
  if (code && !plan.recurring) {
    if (!email) return res.status(400).json({ error: discountMessage('noemail'), reason: 'noemail' });
    let check;
    try {
      check = await callTracking({ type: 'redeemCheck', code, email });
    } catch (err) {
      console.error('[create-payment] discount validation unreachable:', err);
      return res.status(502).json({ error: discountMessage('unreachable'), reason: 'unreachable' });
    }
    if (!check || !check.ok || !check.valid) {
      const reason = (check && check.reason) || 'invalid';
      return res.status(400).json({ error: discountMessage(reason), reason });
    }
    // Only ONE `code` string is ever accepted per request (never a list), so
    // two discount codes can never stack here — a new code always REPLACES
    // any other. The percent is looked up from our own trusted map (never
    // taken from client input or from Apps Script's response), matching the
    // "price decided server-side" rule above.
    const percent = discountPercentFor(code);
    unitPrice = Math.round(plan.price * (1 - percent / 100));
    discountCode = code;
  }

  // Where SUMIT returns the customer after payment → our callback, which
  // verifies the payment with SUMIT and then marks any code used. Falls back to
  // the request host so it works on Vercel preview + production alike.
  const origin = process.env.SITE_URL || `https://${req.headers.host}`;
  let redirectURL = `${origin}/api/payment-callback?plan=${encodeURIComponent(planKey)}`;
  // Pass the customer email to the callback for ALL orders (not only discounted
  // ones) so the server-side Meta CAPI Purchase can match on a hashed email —
  // materially better attribution than cookies/IP alone. The callback hashes it
  // before sending to Meta; it is never transmitted to Meta in clear text.
  if (email) redirectURL += `&email=${encodeURIComponent(email)}`;
  if (discountCode) redirectURL += `&code=${encodeURIComponent(discountCode)}`;

  // Build the single line item (UnitPrice already reflects any discount).
  const item = {
    Item: { Name: plan.name, SearchMode: 'Automatic' },
    Quantity: plan.qty,
    UnitPrice: unitPrice,
    Currency: 'ILS',
  };

  // Recurring subscription: bill every month, open-ended ("ביטול בכל עת").
  // Duration_Months = charge interval (1 = monthly); Recurrence flags it as a
  // standing order. We intentionally omit a payments cap so it continues until
  // cancelled in the SUMIT dashboard. VERIFY these two fields against your
  // account's Swagger if a subscription doesn't register as recurring.
  if (plan.recurring) {
    item.Duration_Months = 1;
    item.Recurrence = 1;
  }

  // Shipping address (collected on the order page for subscriptions). Forwarded
  // to SUMIT's customer record when present; unknown/empty fields are simply
  // omitted so non-subscription orders are unaffected.
  const customer = {
    Name:         clean(body.name, 100),
    EmailAddress: email,
    Phone:        clean(body.phone, 30),
    SearchMode:   'Automatic',
  };
  const address = clean(body.address, 200);
  const city    = clean(body.city, 100);
  if (address) customer.Address = address;
  if (city)    customer.City = city;

  const sumitRequest = {
    Credentials: { CompanyID, APIKey: apiKey },
    Customer: customer,
    Items: [item],
    // Tell SUMIT our UnitPrice already INCLUDES VAT, so it splits the tax out
    // of ₪155 instead of adding it on top. Field name + string value match
    // SUMIT's own WooCommerce gateway ($Request['VATIncluded'] = 'true';).
    // No VATRate sent on purpose — SUMIT uses the company's configured rate,
    // so the charged total stays exactly ₪155 even if the rate changes.
    VATIncluded: 'true',
    RedirectURL: redirectURL,
    ExternalIdentifier: `ngfm-${planKey}-${discountCode || 'nocode'}-${Date.now()}`,
  };

  try {
    const sumitRes = await fetch(SUMIT_BEGIN_REDIRECT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sumitRequest),
    });

    const data = await sumitRes.json().catch(() => null);
    const paymentUrl = data && data.Data && data.Data.RedirectURL;

    if (!paymentUrl) {
      // Log the full envelope server-side (Vercel logs) for debugging; return a
      // generic message to the client.
      console.error('[create-payment] SUMIT did not return a payment URL:', JSON.stringify(data));
      const msg = (data && data.UserErrorMessage) || 'Payment provider error';
      return res.status(502).json({ error: msg });
    }

    return res.status(200).json({ paymentUrl });
  } catch (err) {
    console.error('[create-payment] Request to SUMIT failed:', err);
    return res.status(502).json({ error: 'Could not reach payment provider' });
  }
};
