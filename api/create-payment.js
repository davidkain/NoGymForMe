/**
 * POST /api/create-payment   (Vercel Serverless Function, Node.js)
 *
 * Creates a SUMIT hosted payment page and returns its URL. This code runs ONLY
 * on the server — the SUMIT CompanyID + APIKey live in environment variables
 * and are never sent to the browser.
 *
 * SECURITY: the browser sends only plan KEYS (single item `plan`, or a multi-
 * item `items:[{plan,qty}]`). The PRICE is decided here, server-side, from the
 * PLANS table below. The client can never set its own amount. Keep prices in
 * sync with the display-only PLANS object in order.html / index.html.
 *
 * SUMIT contract (confirmed from SUMIT's WooCommerce gateway source):
 *   Endpoint : POST https://api.sumit.co.il/billing/payments/beginredirect/
 *   Auth     : body.Credentials = { CompanyID, APIKey }
 *   Success  : response.Status === 0 and response.Data.RedirectURL holds the
 *              hosted payment-page URL to send the customer to.
 *   Recurring: item-level Duration_Months + Recurrence (subscriptions).
 *   Multiple : Items is an array — one entry per distinct package (Quantity
 *              carries how many of that package the customer bought).
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
  single:       { name: 'חבילת הביישן',                      price: 198, recurring: false },
  starter:      { name: 'חבילת יאללה, בוא ננסה',             price: 396, recurring: false },
  results:      { name: 'חבילת אול-אין (כי הקיץ כבר פה...)', price: 496, recurring: false },
};

// Max quantity of any single package in one order — a defensive cap so a
// tampered request can't create an absurd line item.
const MAX_QTY = 20;

// Normalize the request body into a list of { planKey, plan, qty }.
// Backward compatible: a single `plan` key (used by direct / ad links) still
// works and yields a one-line order. Returns { error } on any unknown plan.
function parseOrder(body) {
  if (Array.isArray(body.items) && body.items.length) {
    const out = [];
    for (const raw of body.items) {
      const key = String((raw && raw.plan) || '');
      const plan = PLANS[key];
      if (!plan) return { error: 'Unknown plan' };
      let qty = parseInt(raw && raw.qty, 10);
      if (!Number.isFinite(qty) || qty < 1) qty = 1;
      if (qty > MAX_QTY) qty = MAX_QTY;
      out.push({ planKey: key, plan, qty });
    }
    return { order: out };
  }
  const key = String(body.plan || '');
  const plan = PLANS[key];
  if (!plan) return { error: 'Unknown plan' };
  return { order: [{ planKey: key, plan, qty: 1 }] };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Vercel auto-parses a JSON body into req.body for application/json requests.
  const body = req.body || {};
  const parsed = parseOrder(body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const order = parsed.order;
  const anyRecurring = order.some((o) => o.plan.recurring);

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
  //
  // Only ONE `code` string is ever accepted per request (never a list), so two
  // codes can never stack. The percent is looked up from our own trusted map
  // (discount-codes.js) — never from client input or Apps Script — and applied
  // order-wide: it reduces EACH one-time line's unit price (rounded per unit),
  // matching the original single-item behavior exactly.
  const code = clean(body.code, 40).toUpperCase();
  let discountFactor = 1;
  let discountCode = '';
  if (code && !anyRecurring) {
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
    const percent = discountPercentFor(code);
    discountFactor = 1 - percent / 100;
    discountCode = code;
  }

  // Build the SUMIT line items (server prices; discount already applied per
  // unit) and compute the order total the callback reports to Meta CAPI.
  let orderTotal = 0;
  const items = order.map(({ plan, qty }) => {
    const unitPrice = Math.round(plan.price * discountFactor);
    orderTotal += unitPrice * qty;
    const item = {
      Item: { Name: plan.name, SearchMode: 'Automatic' },
      Quantity: qty,
      UnitPrice: unitPrice,
      Currency: 'ILS',
    };
    // Recurring subscription (kept for safety; not currently sellable via cart).
    if (plan.recurring) {
      item.Duration_Months = 1;
      item.Recurrence = 1;
    }
    return item;
  });

  // Where SUMIT returns the customer after payment → our callback, which
  // verifies the payment with SUMIT and then marks any code used. Falls back to
  // the request host so it works on Vercel preview + production alike.
  // `plan` is the single plan key for one-line orders (keeps thank-you labels
  // working) or 'multi' for a mixed cart; `amt` is the server-computed total so
  // the callback reports the exact discounted value to Meta CAPI.
  const origin = process.env.SITE_URL || `https://${req.headers.host}`;
  const planParam = order.length === 1 ? order[0].planKey : 'multi';
  let redirectURL = `${origin}/api/payment-callback?plan=${encodeURIComponent(planParam)}&amt=${orderTotal}`;
  // Pass the customer email to the callback for ALL orders (not only discounted
  // ones) so the server-side Meta CAPI Purchase can match on a hashed email —
  // materially better attribution than cookies/IP alone. The callback hashes it
  // before sending to Meta; it is never transmitted to Meta in clear text.
  if (email) redirectURL += `&email=${encodeURIComponent(email)}`;
  if (discountCode) redirectURL += `&code=${encodeURIComponent(discountCode)}`;

  // Shipping address (collected on the order page). Forwarded to SUMIT's
  // customer record when present; empty fields are simply omitted.
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

  const idSummary = order.map((o) => `${o.planKey}x${o.qty}`).join('_');
  const sumitRequest = {
    Credentials: { CompanyID, APIKey: apiKey },
    Customer: customer,
    Items: items,
    // Tell SUMIT our UnitPrice already INCLUDES VAT, so it splits the tax out
    // instead of adding it on top. Field name + string value match SUMIT's own
    // WooCommerce gateway ($Request['VATIncluded'] = 'true';). No VATRate sent
    // on purpose — SUMIT uses the company's configured rate.
    VATIncluded: 'true',
    RedirectURL: redirectURL,
    ExternalIdentifier: `ngfm-${idSummary}-${discountCode || 'nocode'}-${Date.now()}`,
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
