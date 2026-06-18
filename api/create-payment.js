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

// SOURCE OF TRUTH for what each plan costs. Prices are VAT-inclusive (ILS).
const PLANS = {
  single:       { name: 'חבילת הביישן',                      price: 198, qty: 1, recurring: false },
  starter:      { name: 'חבילת יאללה, בוא ננסה',             price: 396, qty: 1, recurring: false },
  results:      { name: 'חבילת אול-אין (כי הקיץ כבר פה...)', price: 496, qty: 1, recurring: false },
  subscription: { name: 'מנוי חודשי',                        price: 155, qty: 1, recurring: true  },
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

  // Where SUMIT returns the customer after a successful payment. Falls back to
  // the request's own host so it works on Vercel preview + production alike.
  const origin = process.env.SITE_URL || `https://${req.headers.host}`;
  const redirectURL = `${origin}/thank-you.html?plan=${encodeURIComponent(planKey)}`;

  // Light, defensive normalization of customer fields (SUMIT also validates).
  const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

  // Build the single line item.
  const item = {
    Item: { Name: plan.name, SearchMode: 'Automatic' },
    Quantity: plan.qty,
    UnitPrice: plan.price,
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

  const sumitRequest = {
    Credentials: { CompanyID, APIKey: apiKey },
    Customer: {
      Name:         clean(body.name, 100),
      EmailAddress: clean(body.email, 150),
      Phone:        clean(body.phone, 30),
      SearchMode:   'Automatic',
    },
    Items: [item],
    VATIncludedInPrices: true, // our prices already include VAT
    RedirectURL: redirectURL,
    ExternalIdentifier: `ngfm-${planKey}-${Date.now()}`,
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
