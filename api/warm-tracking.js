/**
 * GET /api/warm-tracking   (Vercel Cron target — see "crons" in vercel.json)
 *
 * Keeps the Apps Script web app warm so a customer's discount code isn't the
 * request that pays for waking it up.
 *
 * WHY THIS EXISTS
 * Measured in production 2026-07-28: the first redeemCheck after an idle period
 * took >25s (aborting a 25s budget), while calls seconds later took 2-5s. The
 * retry in api/create-payment.js turns that into a slow success rather than a
 * failed checkout, but the first shopper after a quiet spell still waits ~27s
 * for "החל" to do anything.
 *
 * WHY A PLAIN HTTP GET, AND NOT AN APPS SCRIPT TRIGGER
 * completed-orders-sync.gs already runs syncCompletedOrders on a 5-minute
 * time-based trigger, and sendRecoveryEmails runs every 30 minutes — so the
 * script PROJECT executes constantly, and the web app is cold anyway. Trigger
 * executions and /exec web-app requests evidently don't share warmth, so the
 * ping has to be a real request to the /exec URL.
 *
 * WHY THIS IS CHEAP
 * doGet with no params doesn't open the spreadsheet at all — it reads one Script
 * Property and returns {ok, ping}. So this burns a trivial slice of the Apps
 * Script daily runtime quota, unlike the ?type=bizStats dashboard path.
 */

'use strict';

// Same endpoint (and same env override) as the rest of api/ and tracking.js.
const TRACKING_WEBAPP_URL = process.env.TRACKING_WEBAPP_URL ||
  'https://script.google.com/macros/s/AKfycbwBmCaPLs3cFn2zvJw4vuMoFypgigvDIJbPuLxnLTebWOISz5o892F_H0gLtBtFvfn5/exec';

// Generous: the whole point is that this call is sometimes very slow. We want it
// to WAIT and absorb the cold start so a shopper doesn't have to.
const WARM_TIMEOUT_MS = 60000;

// Only Vercel's scheduler should be able to trigger this. Without a guard it's a
// public button that makes us hit Apps Script, i.e. a free way to burn someone
// else's daily quota.
//
// Vercel sends `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set, and
// always identifies itself by user-agent. Prefer the secret when it exists, so
// setting that env var upgrades this from "hard to guess" to "actually
// authenticated" with no code change.
function isAuthorizedCron(req) {
  const secret = process.env.CRON_SECRET;
  if (secret) return req.headers.authorization === `Bearer ${secret}`;
  return /vercel-cron/i.test(String(req.headers['user-agent'] || ''));
}

module.exports = async (req, res) => {
  if (!isAuthorizedCron(req)) return res.status(401).json({ error: 'Unauthorized' });

  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WARM_TIMEOUT_MS);
  try {
    const r = await fetch(TRACKING_WEBAPP_URL, { signal: ctrl.signal });
    const ms = Date.now() - started;
    // A cold hit here is the SUCCESS case — it means this ping absorbed the
    // wake-up that a shopper would otherwise have paid for. Log it either way so
    // the warm/cold ratio over time shows whether the 5-minute interval is
    // actually holding the instance open.
    console.log(`[warm-tracking] ok in ${ms}ms (http ${r.status})${ms > 8000 ? ' — COLD, ping earned its keep' : ''}`);
    return res.status(200).json({ ok: true, ms, upstream: r.status });
  } catch (err) {
    // Never throw: a failed warm-up must not look like a broken deployment, and
    // there is nothing to retry — the next tick is 5 minutes away.
    const ms = Date.now() - started;
    console.warn(`[warm-tracking] failed after ${ms}ms:`, err && err.name);
    return res.status(200).json({ ok: false, ms, error: (err && err.name) || 'unknown' });
  } finally {
    clearTimeout(timer);
  }
};
