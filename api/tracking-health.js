/**
 * GET /api/tracking-health   (Vercel Serverless Function)
 *
 * Answers one question: is the conversion tracking that Meta optimises your ads
 * on actually working RIGHT NOW?
 *
 * WHY THIS EXISTS
 * The server-side Meta CAPI Purchase is the signal that survives closed tabs,
 * ad blockers and iOS ATT — it is the one that teaches Meta who buys. Its
 * failure path is completely silent by design: lib/meta-capi.js swallows the
 * error and returns { ok:false }, api/meta-capi-purchase.js always returns HTTP
 * 200, and api/payment-callback.js never blocks the customer's redirect on it.
 * That silence is not theoretical: an access token without permission on the
 * configured pixel makes Meta reject every single Purchase with a 400, and
 * nothing anywhere surfaces it.
 *
 * HOW TO USE IT
 * Point any uptime monitor at this URL. It returns 503 the moment tracking
 * breaks, so you get told instead of finding out from a flat sales chart.
 *
 *   200  { ok: true,  ... }   tracking is healthy
 *   503  { ok: false, ... }   something is broken — read `checks`
 *
 * The Meta check is a READ-ONLY Graph API lookup. It sends no event, so calling
 * this endpoint never puts a test Purchase into your real conversion data.
 *
 * CAVEAT, so this is not mistaken for proof: the check reads the pixel object,
 * it does not post to /events. A token could in principle read the pixel and
 * still be refused on event delivery. Treat a green result as "the token can see
 * the pixel", and the CAPI-REJECTED marker in lib/meta-capi.js as the ground
 * truth for real purchases.
 *
 * SECURITY: no secrets are ever returned — only whether each is present. The
 * pixel id is already public (it ships in the page HTML via fbq('init', …)).
 * Optionally gate access by setting TRACKING_HEALTH_KEY, then call with
 * ?key=<secret>. Fails OPEN until that var is set, so the endpoint is useful
 * immediately — matching the pattern api/summit-webhook.js already uses.
 */

'use strict';

const { checkPixelAccess } = require('../lib/meta-capi');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const gate = process.env.TRACKING_HEALTH_KEY;
  if (gate) {
    const provided = (req.query && req.query.key) || req.headers['x-health-key'] || '';
    if (provided !== gate) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // Meta: the real permission probe. This is the check that matters.
  const meta = await checkPixelAccess();

  // TikTok and SUMIT: presence only. Neither exposes a read-only permission
  // check we can call without side effects, so we deliberately do NOT claim
  // they are working — only that they are configured. Verify TikTok server
  // events in TikTok Events Manager.
  const tiktokConfigured = !!(process.env.TIKTOK_PIXEL_ID && process.env.TIKTOK_ACCESS_TOKEN);
  const sumitConfigured = !!(process.env.SUMIT_COMPANY_ID && process.env.SUMIT_API_KEY);

  const checks = {
    metaCapi: meta,
    tiktokEvents: {
      configured: tiktokConfigured,
      note: 'presence only — not a permission check',
    },
    sumitPayments: {
      configured: sumitConfigured,
      note: 'presence only — checkout is proven only by a real /api/create-payment call',
    },
  };

  // Only Meta and SUMIT gate the overall verdict. A missing TikTok token costs
  // attribution on one channel; a broken Meta token blinds the optimiser that
  // is spending the budget, and a missing SUMIT credential means nobody can pay
  // at all.
  const ok = !!meta.ok && sumitConfigured;

  if (!ok) {
    console.error('[tracking-health] UNHEALTHY:', JSON.stringify(checks));
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(ok ? 200 : 503).json({ ok, checkedAt: new Date().toISOString(), checks });
};
