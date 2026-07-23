/**
 * NoGymForMe — tracking endpoint
 *
 * Receives POSTs from the website, writes a row to the right tab of the
 * configured Google Sheet, highlights the new row yellow, and emails
 * nogymforme2026@gmail.com a notification with the full sheet attached as XLSX.
 *
 * Initial setup:
 *   1) Create a new Google Sheet you own. Note its ID (the long string in
 *      the URL between /d/ and /edit).
 *   2) script.google.com → New project → paste THIS file's contents.
 *   3) EITHER paste the Sheet ID into SHEET_ID below ONCE (it will be
 *      auto-migrated to Script Properties on the first request and survive
 *      any future file replacement),
 *      OR set it directly via Project Settings → Script properties →
 *      add property "SHEET_ID" with your sheet ID as the value.
 *   4) Deploy → New deployment → type "Web app" → execute as "Me",
 *      access "Anyone". Copy the deployment URL.
 *   5) Paste that URL into tracking.js → CONFIG.URL.
 *
 * Future updates: when you replace this file with a newer version that has
 * `SHEET_ID = ''`, the script reads the persisted value from Script
 * Properties — your SHEET_ID is no longer destroyed by pasting over the file.
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Empty by default — committed source must not contain secrets. The script
// reads the real value from Script Properties at runtime (see getSheetId()).
// You ONLY need to fill this in once during initial setup; it auto-migrates.
const SHEET_ID = '';
const NOTIFY_EMAIL = 'nogymforme2026@gmail.com';
// CC'd ONLY on completed-order notifications (not discount/abandoned/app-waitlist
// events), so a purchase is always seen by more than one person. Set to '' to
// disable. SUMIT's own per-sale email is the primary fallback; this is backup.
const ORDER_ALERT_CC = 'itaymid@gmail.com';
const TIMEZONE = 'Asia/Jerusalem';

// Owner/admin emails that always pass the members-area gate, regardless of
// whether they appear in Completed Orders. Useful so the operator can test
// the gate, do customer support, or access the members area without having
// to place a real order. Add team members here as needed.
// All comparisons are case-insensitive + whitespace-trimmed.
const OWNER_EMAILS = [
  NOTIFY_EMAIL,                       // nogymforme2026@gmail.com — operator
  'davidkain1@gmail.com',             // David — owner
  'davidkain1+stores@gmail.com'       // App Store + Google Play reviewer credential
                                      // (Gmail plus-addressing — routes to davidkain1@gmail.com inbox)
];

const TABS = {
  discount:  'Discount Signups',
  started:   'Abandoned Checkouts',
  completed: 'Completed Orders',
  appwait:   'App Waitlist (iOS)'
};

const HEADERS = {
  discount:  ['Timestamp', 'Email', 'Source', 'User-Agent', 'Code', 'Used', 'Used At', 'Code Emailed At',
              'Expires At', 'Percent'],
  // New address columns are APPENDED at the end so the auto-migration in
  // ensureSheet() keeps existing rows aligned (old rows just get blank cells).
  started:   ['Timestamp', 'Name', 'Email', 'Phone', 'Plan', 'Status', 'User-Agent', 'Address', 'City', 'Comments',
              'Recovery Emailed At', 'Recovery Code'],
  completed: ['Timestamp', 'Order #', 'Name', 'Email', 'Phone', 'Address', 'City', 'Plan', 'Total', 'User-Agent', 'Comments'],
  appwait:   ['Timestamp', 'Email', 'Source', 'User-Agent']
};

const HEADER_BG = '#E8D900';   // brand gold
const HIGHLIGHT_BG = '#FFF59D'; // soft yellow for newly added rows

const DISCOUNT_PERCENT = 10;    // first-order discount the popup-issued, per-email codes grant

// Static, non-personalized promo codes: fixed percent, NOT tied to a specific
// customer email, and NOT single-use (never marked "used"). Add new codes
// here — keep IN SYNC with STATIC_DISCOUNT_CODES in api/create-payment.js and
// api/payment-callback.js (three separate deploys, no shared import between
// this Apps Script project and the Vercel repo).
const STATIC_DISCOUNT_CODES = {
  'FRIENDS15': 15
};

// ── Abandoned-cart recovery campaign ──────────────────────────────────────
// sendRecoveryEmails() runs on a time-based trigger and emails everyone who
// reached checkout, left an email, and never completed an order. Each gets a
// personal, single-use, time-limited code.
//
// RECOVERY_CODE_PREFIX is load-bearing: api/create-payment.js derives the 15%
// from this exact prefix (see PREFIX_PERCENTS in lib/discount-codes.js). If you
// change it here you MUST change it there, or recovery buyers get charged the
// 10% default while the email promises 15%.
const RECOVERY_CODE_PREFIX  = 'BACK15-';
const RECOVERY_PERCENT      = 15;
const RECOVERY_EXPIRY_HOURS = 48;   // code lifetime, promised in the email copy
const RECOVERY_MIN_AGE_MIN  = 60;   // don't email until the cart is ~1h cold
// Upper age bound, and the reason the FIRST run can't blast your backlog: rows
// older than this are permanently out of scope. Also self-heals a trigger
// outage — a day of downtime doesn't cause a burst of stale sends on recovery.
const RECOVERY_MAX_AGE_HRS  = 72;
// Per-run send cap. A consumer Gmail account allows ~100 GmailApp recipients per
// day and the brand inbox also sends order confirmations + code emails, so leave
// headroom. Hitting the cap pings the operator instead of silently dropping people.
const RECOVERY_MAX_PER_RUN  = 40;
const RECOVERY_CART_URL =
  'https://www.nogymforme.com/order.html?plan=results&utm_source=email&utm_medium=recovery&utm_campaign=abandoned_allin';

// Human-readable label for each `source` value the site sends.
// Used in email subject + body so a glance at the inbox tells you
// which package the lead was looking at, without opening the email.
const SOURCE_LABELS = {
  'popup':                 '🪄 10% popup',
  'waitlist_single':       '🍶 חבילת הביישן (1 בקבוק)',
  'waitlist_starter':      '🍶🍶 חבילת יאללה (2 בקבוקים)',
  'waitlist_results':      '🍶🍶🍶 חבילת אול-אין (3 בקבוקים)',
  'waitlist_subscription': '♻️ מנוי חודשי'
};
function labelForSource(source) {
  return SOURCE_LABELS[source] || source || '(unknown source)';
}
// Label for the tracking `plan` field, which is either a single package KEY
// (single/starter/results) → its emoji label, or a readable multi-item cart
// summary (e.g. "חבילת אול-אין ×2, חבילת הביישן") → used as-is.
function planLabelFor_(plan) {
  if (!plan) return '(no plan)';
  var byKey = SOURCE_LABELS['waitlist_' + plan];
  return byKey ? byKey : String(plan);
}

// Clean plan names (no emoji prefixes) for the customer-facing confirmation
// email. KEEP IN SYNC with PLAN_LABELS in thank-you.html.
const PLAN_NAMES = {
  single:       'חבילת הביישן',
  starter:      'חבילת יאללה, בוא ננסה',
  results:      'חבילת אול-אין',
  subscription: 'מנוי חודשי'
};

// ─── VIP SUBSCRIPTION — 90-day journey pricing ───────────────────────────────
// See VIP-BILLING-SPEC.md. The ₪155 VIP price is the "full-journey" price;
// cancelling before 3 monthly charges clear re-prices the bottles already
// shipped to the regular one-time price (₪198) and charges the ₪43/bottle
// difference. The 14-day money-back guarantee always wins (one per customer,
// for life). All money math is integer NIS.
const VIP = {
  MONTHLY: 155,             // discounted monthly price (1 bottle)
  REGULAR: 198,             // regular one-time per-bottle price
  JOURNEY_CYCLES: 3,        // successful monthly charges = journey complete (90d)
  GUARANTEE_DAYS: 14,       // money-back window, day 14 inclusive
  SHIPPING_FALLBACK_DAYS: 5 // if delivery date unknown: anchor = first charge + 5d
};
// Per-bottle clawback = REGULAR - MONTHLY. Computed, never hardcoded, so a
// price/promo change can't silently break the settle-up math (spec E9).
function vipDiff() { return VIP.REGULAR - VIP.MONTHLY; }   // ₪43

const VIP_TABS = { subs: 'VIP Subscriptions', cancels: 'VIP Cancellations' };
const VIP_HEADERS = {
  // One row per VIP subscriber. `Cycles` = successful monthly charges = bottles
  // shipped. `Guarantee Used` enforces one-per-customer (spec E11). The Summit
  // Customer ID + Payment ID are the saved-method references used to charge the
  // early-cancellation settle-up. `Cycle Refs` dedupes recurring webhooks.
  subs: ['Sub ID', 'Created', 'Name', 'Email', 'Phone', 'National ID',
         'Dedup Key', 'Summit Customer ID', 'Summit Payment ID', 'First Charge',
         'First Delivery', 'Cycles', 'Last Cycle Charge', 'Status',
         'Guarantee Used', 'Cycle Refs'],
  // Audit log: one row per cancellation outcome (also the idempotency ledger).
  cancels: ['Timestamp', 'Sub ID', 'Email', 'Dedup Key', 'Cycles',
            'Branch', 'Guarantee Applied', 'Refund', 'Clawback',
            'Charge Status', 'Summit Txn', 'Cancel Txn ID']
};
// 1-based column indices for VIP_HEADERS.subs — keep in sync with the array.
const VIP_COL = {
  subId: 1, created: 2, name: 3, email: 4, phone: 5, nationalId: 6,
  dedupKey: 7, summitCustomerId: 8, summitPaymentId: 9, firstCharge: 10,
  firstDelivery: 11, cycles: 12, lastCharge: 13, status: 14,
  guaranteeUsed: 15, cycleRefs: 16
};

// ─── ENTRY POINTS ────────────────────────────────────────────────────────────
function doGet(e) {
  var params = (e && e.parameter) || {};
  // READ-ONLY: daily completed-order stats for the private traffic dashboard.
  if (params.type === 'orderStats') return orderStats_(params);
  // READ-ONLY: funnel counts + orders-by-plan for the private traffic dashboard.
  if (params.type === 'bizStats') return bizStats_(params);
  var id = getSheetId();
  return jsonOut({ ok: !!id, ping: 'NoGymForMe tracker alive', configured: !!id });
}

/**
 * READ-ONLY: funnel + orders-by-plan for the traffic dashboard (no PII returned).
 * Auth: ?key= must equal Script Property ORDERS_STATS_KEY.
 * Optional ?since=YYYY-MM-DD & ?until=YYYY-MM-DD (inclusive, by row Timestamp).
 * Response: { ok:true,
 *   funnel: { popupSignups, checkoutsStarted, orders },
 *   byPlan: [ {plan, count, revenue}, ... ] }.
 * Team/test rows (owner emails + order-alert CC) are excluded everywhere.
 */
function bizStats_(params) {
  var expected = PropertiesService.getScriptProperties().getProperty('ORDERS_STATS_KEY');
  if (!expected || String(params.key || '') !== String(expected)) {
    return jsonOut({ ok: false, error: 'unauthorized' });
  }
  var sheetId = getSheetId();
  if (!sheetId) return jsonOut({ ok: false, error: 'not configured' });
  var ss = SpreadsheetApp.openById(sheetId);
  var since = String(params.since || '');
  var until = String(params.until || '');

  var excluded = {};
  for (var k = 0; k < OWNER_EMAILS.length; k++) excluded[String(OWNER_EMAILS[k]).toLowerCase().trim()] = true;
  if (ORDER_ALERT_CC) excluded[String(ORDER_ALERT_CC).toLowerCase().trim()] = true;

  function toDate(raw) {
    return (raw instanceof Date)
      ? Utilities.formatDate(raw, TIMEZONE, 'yyyy-MM-dd')
      : String(raw || '').slice(0, 10);
  }
  function inRange(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    if (since && date < since) return false;
    if (until && date > until) return false;
    return true;
  }
  // Count in-range, non-team rows of a tab. emailCol is 0-based.
  function countTab(tabName, emailCol) {
    var sheet = ss.getSheetByName(tabName);
    if (!sheet || sheet.getLastRow() < 2) return 0;
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
    var n = 0;
    for (var i = 0; i < values.length; i++) {
      if (!inRange(toDate(values[i][0]))) continue;
      if (excluded[String(values[i][emailCol] || '').toLowerCase().trim()]) continue;
      n++;
    }
    return n;
  }

  var popupSignups = countTab(TABS.discount, 1);    // Discount Signups: Email = col 2 (index 1)
  var checkoutsStarted = countTab(TABS.started, 2); // Abandoned Checkouts: Email = col 3 (index 2)

  // Completed Orders → orders count + revenue grouped by Plan.
  var byPlanMap = {};
  var ordersCount = 0;
  var cs = ss.getSheetByName(TABS.completed);
  if (cs && cs.getLastRow() >= 2) {
    var cv = cs.getRange(2, 1, cs.getLastRow() - 1, 9).getValues();
    for (var j = 0; j < cv.length; j++) {
      if (!inRange(toDate(cv[j][0]))) continue;
      if (excluded[String(cv[j][3] || '').toLowerCase().trim()]) continue; // Email = index 3
      ordersCount++;
      var plan = String(cv[j][7] || '').trim() || '(unknown)';             // Plan = index 7
      var total = parseFloat(String(cv[j][8]).replace(/[^0-9.\-]/g, '')) || 0; // Total = index 8
      if (!byPlanMap[plan]) byPlanMap[plan] = { plan: plan, count: 0, revenue: 0 };
      byPlanMap[plan].count += 1;
      byPlanMap[plan].revenue += total;
    }
  }
  var byPlan = Object.keys(byPlanMap)
    .map(function (key) { return byPlanMap[key]; })
    .sort(function (a, b) { return b.revenue - a.revenue; });

  return jsonOut({ ok: true,
    funnel: { popupSignups: popupSignups, checkoutsStarted: checkoutsStarted, orders: ordersCount },
    byPlan: byPlan });
}

/**
 * READ-ONLY: per-day completed-order count + revenue for the traffic dashboard.
 * Auth: ?key= must equal Script Property ORDERS_STATS_KEY (no PII is ever returned).
 * Optional ?since=YYYY-MM-DD & ?until=YYYY-MM-DD (inclusive, by row Timestamp).
 * Response: { ok:true, orders:[ {date:'YYYY-MM-DD', count:N, revenue:N}, ... ] }.
 */
function orderStats_(params) {
  var expected = PropertiesService.getScriptProperties().getProperty('ORDERS_STATS_KEY');
  if (!expected || String(params.key || '') !== String(expected)) {
    return jsonOut({ ok: false, error: 'unauthorized' });
  }
  var sheetId = getSheetId();
  if (!sheetId) return jsonOut({ ok: false, error: 'not configured' });
  var sheet = SpreadsheetApp.openById(sheetId).getSheetByName(TABS.completed);
  if (!sheet || sheet.getLastRow() < 2) return jsonOut({ ok: true, orders: [] });

  var since = String(params.since || '');
  var until = String(params.until || '');
  // Completed Orders columns: 1 = Timestamp ('yyyy-MM-dd HH:mm:ss'), 9 = Total.
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 9).getValues();
  // Exclude team/test orders (owner emails + the order-alert CC) so the
  // dashboard reflects real customers only.
  var excluded = {};
  for (var k = 0; k < OWNER_EMAILS.length; k++) excluded[String(OWNER_EMAILS[k]).toLowerCase().trim()] = true;
  if (ORDER_ALERT_CC) excluded[String(ORDER_ALERT_CC).toLowerCase().trim()] = true;

  var byDate = {};
  for (var i = 0; i < values.length; i++) {
    // Skip team/test orders by email (col 4 = Email).
    var email = String(values[i][3] || '').toLowerCase().trim();
    if (excluded[email]) continue;
    // Timestamp cell may be a real Date (Sheets auto-converts) or a string.
    var raw = values[i][0];
    var date = (raw instanceof Date)
      ? Utilities.formatDate(raw, TIMEZONE, 'yyyy-MM-dd')
      : String(raw || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (since && date < since) continue;
    if (until && date > until) continue;
    var total = parseFloat(String(values[i][8]).replace(/[^0-9.\-]/g, '')) || 0;
    if (!byDate[date]) byDate[date] = { date: date, count: 0, revenue: 0 };
    byDate[date].count += 1;
    byDate[date].revenue += total;
  }
  var out = Object.keys(byDate).sort().map(function (k) { return byDate[k]; });
  return jsonOut({ ok: true, orders: out });
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const type = data.type;

    // ── READ-ONLY: members-area email verification ─────────────────────────
    // Special branch BEFORE the TABS check, because `verify` doesn't write
    // anything — it just answers "is this email in Completed Orders?".
    if (type === 'verify') {
      const reqEmail = String(data.email || '').toLowerCase().trim();

      // Owner/admin allowlist — operators always pass the gate.
      // Lets the team access the members area for testing + support
      // without needing to be in Completed Orders.
      for (let i = 0; i < OWNER_EMAILS.length; i++) {
        if (String(OWNER_EMAILS[i]).toLowerCase().trim() === reqEmail) {
          return jsonOut({ ok: true, verified: true });
        }
      }

      const sheetId = getSheetId();
      if (!sheetId) return jsonOut({ ok: false, error: 'not configured' });
      const ss = SpreadsheetApp.openById(sheetId);
      const sheet = ss.getSheetByName(TABS.completed);
      // No tab yet = no completed orders yet = no one is a verified customer.
      if (!sheet) return jsonOut({ ok: true, verified: false });
      return jsonOut({ ok: true, verified: completedEmailExists(sheet, reqEmail) });
    }

    // ── READ-ONLY: validate a discount code at checkout ────────────────────
    // The code must exist, belong to the given email (anti-sharing), and be
    // unused. Does NOT mark it used — that happens only after SUMIT confirms
    // payment (see the markUsed branch + the payment-callback function).
    //
    // A checkout ever sends exactly ONE `code` string (never a list), so two
    // discount codes can never be validated — let alone applied — together.
    if (type === 'redeemCheck') {
      const upperCode = String(data.code || '').toUpperCase().trim();

      // Static promo codes (e.g. FRIENDS15): no email binding, not single-use,
      // always valid while listed in STATIC_DISCOUNT_CODES above.
      if (STATIC_DISCOUNT_CODES.hasOwnProperty(upperCode)) {
        return jsonOut({ ok: true, valid: true, percent: STATIC_DISCOUNT_CODES[upperCode] });
      }

      const sheetId = getSheetId();
      if (!sheetId) return jsonOut({ ok: false, error: 'not configured' });
      const sheet = SpreadsheetApp.openById(sheetId).getSheetByName(TABS.discount);
      if (!sheet) return jsonOut({ ok: true, valid: false, reason: 'notfound' });
      const rec = findDiscountByCode(sheet, data.code);
      if (!rec)                                                  return jsonOut({ ok: true, valid: false, reason: 'notfound' });
      if (rec.email !== String(data.email || '').toLowerCase().trim()) return jsonOut({ ok: true, valid: false, reason: 'wrongemail' });
      if (rec.used)                                              return jsonOut({ ok: true, valid: false, reason: 'used' });
      // Time-limited codes (abandoned-cart recovery). Evergreen popup codes
      // leave Expires At blank and skip this entirely.
      if (rec.expiresAt && rec.expiresAt.getTime() < Date.now())  return jsonOut({ ok: true, valid: false, reason: 'expired' });
      // `percent` here is DISPLAY ONLY — the checkout page uses it to show the
      // right saving. api/create-payment.js re-derives the charged percent from
      // the code string itself and never trusts this number.
      return jsonOut({ ok: true, valid: true, percent: rec.percent || DISCOUNT_PERCENT });
    }

    // ── WRITE: mark a code used (called by the server AFTER SUMIT confirms a
    // valid payment). Idempotent: re-marking an already-used code is a no-op. ─
    if (type === 'markUsed') {
      const upperCode = String(data.code || '').toUpperCase().trim();

      // Static promo codes are reusable across customers — nothing to mark.
      if (STATIC_DISCOUNT_CODES.hasOwnProperty(upperCode)) {
        return jsonOut({ ok: true, used: true, alreadyUsed: false });
      }

      const sheetId = getSheetId();
      if (!sheetId) return jsonOut({ ok: false, error: 'not configured' });
      const sheet = SpreadsheetApp.openById(sheetId).getSheetByName(TABS.discount);
      if (!sheet) return jsonOut({ ok: false, error: 'no discount tab' });
      const rec = findDiscountByCode(sheet, data.code);
      if (!rec) return jsonOut({ ok: false, error: 'notfound' });
      if (data.email && rec.email !== String(data.email).toLowerCase().trim()) {
        return jsonOut({ ok: false, error: 'wrongemail' });
      }
      if (!rec.used) {
        sheet.getRange(rec.rowIndex, 6).setValue('Yes'); // col 6 = Used
        sheet.getRange(rec.rowIndex, 7).setValue(        // col 7 = Used At
          Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss'));
      }
      return jsonOut({ ok: true, used: true, alreadyUsed: rec.used });
    }

    // ── VIP: store a subscription + recurring token at signup (idempotent on
    // subId). Wire from your VIP checkout once Summit returns customer/payment ids. ─
    if (type === 'vipSubscribe') return handleVipSubscribe(data);

    // ── VIP: record a successful monthly charge (from the recurring-billing
    // webhook). Increments Cycles; sets First Charge / First Delivery. ─────────
    if (type === 'vipCycle') return handleVipCycle(data);

    // ── VIP: cancel step 1 — email a one-time code to prove email ownership. ──
    if (type === 'vipCancelRequestOtp') return handleVipCancelRequestOtp(data);

    // ── VIP: cancellation handler — 90-day-journey settle-up (spec §3).
    // Requires a valid OTP (step 2). Idempotent on cancelTxnId. Safe mode until
    // Summit props are set. ───────────────────────────────────────────────────
    if (type === 'vipCancel') return handleVipCancel(data);

    // ── VIP: Summit recurring-payment webhook → records a monthly cycle.
    // Matches the subscriber by Summit customer id / email; dedupes on the
    // Summit payment ref so retried webhooks don't double-count. ──────────────
    if (type === 'summitWebhook') return handleSummitWebhook_(data);

    if (!TABS[type]) return jsonOut({ ok: false, error: 'unknown type' });

    const sheetId = getSheetId();
    if (!sheetId) {
      // Fail with a clear message instead of "ארגומנט לא חוקי: id".
      // Also email the operator so a silent config breakage is loud.
      const msg = 'SHEET_ID is not configured. Set it via Project Settings → ' +
                  'Script properties (key: SHEET_ID), or paste it into the ' +
                  'SHEET_ID const at the top of this file ONCE — the value ' +
                  'will auto-migrate to Script Properties and survive future ' +
                  'file replacements.';
      try {
        MailApp.sendEmail(NOTIFY_EMAIL, '🚨 NGFM tracker — SHEET_ID missing',
          msg + '\n\nIncoming payload was:\n' + (e && e.postData && e.postData.contents || ''));
      } catch (_) {}
      return jsonOut({ ok: false, error: msg });
    }

    const ss = SpreadsheetApp.openById(sheetId);
    const sheet = ensureSheet(ss, type);

    // Per-email dedup for discount popup signups:
    // Returning visitors on a new device (so localStorage check on the
    // client doesn't catch them) should see the "אחי, כבר קיבלת" message
    // instead of accumulating duplicate rows + duplicate notification
    // emails. The popup is also the only event type that doesn't have a
    // legitimate "submit twice" path — checkouts CAN happen twice for the
    // same email, so dedup is scoped to `discount` only.
    if (type === 'discount' && data.email) {
      // One code per email: if this email already claimed a code, return the
      // SAME code (don't append a new row or notify again).
      var existing = findDiscountByEmail(sheet, data.email);
      if (existing) {
        // Self-heal: a row from before codes existed (blank Code cell) gets a
        // freshly-minted code backfilled + emailed, so legacy signups aren't
        // stuck without a code.
        if (!existing.code) {
          var backfill = generateUniqueCode(sheet);
          sheet.getRange(existing.rowIndex, 5).setValue(backfill); // col 5 = Code
          sheet.getRange(existing.rowIndex, 6).setValue('No');     // col 6 = Used
          sendCustomerCode(data.email, backfill);
          sheet.getRange(existing.rowIndex, 8).setValue(new Date()); // col 8 = Code Emailed At
          return jsonOut({ ok: true, alreadyExists: true, code: backfill });
        }
        maybeResendCode(sheet, existing, data.email); // re-email, max once / 24h
        return jsonOut({ ok: true, alreadyExists: true, code: existing.code });
      }
      // New email → mint a unique code; buildRow() writes it to the sheet.
      data._code = generateUniqueCode(sheet);
    }

    const row = buildRow(type, data);
    sheet.appendRow(row);

    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow, 1, 1, row.length).setBackground(HIGHLIGHT_BG);

    // If a completed order arrives, mark earlier "Abandoned" rows for the same
    // email/phone as Completed so the abandoned tab doesn't lie, and email the
    // buyer a branded order confirmation.
    if (type === 'completed') {
      promoteAbandonedToCompleted(ss, data);
      if (data.email) sendOrderConfirmation(data);
    }

    // Log every abandoned cart to the sheet (row already written above), but only
    // EMAIL the ones we can act on: skip the owner notification for an anonymous
    // cart abandonment that carries no email and no phone. Keeps the inbox to
    // contactable leads while metrics still capture every abandon.
    var skipEmail = (type === 'started' && !data.email && !data.phone);
    if (!skipEmail) sendNotification(type, data, ss);

    // Email the customer their freshly-minted code, and stamp the send time
    // (col 8) so re-sends to returning visitors are rate-limited to once / 24h.
    if (type === 'discount' && data._code) {
      sendCustomerCode(data.email, data._code);
      sheet.getRange(sheet.getLastRow(), 8).setValue(new Date());
    }

    return jsonOut({ ok: true, alreadyExists: false, code: data._code || '' });
  } catch (err) {
    // Best-effort error log; never throw to the client.
    try {
      MailApp.sendEmail(NOTIFY_EMAIL, 'NGFM tracker error', String(err) + '\n\n' + (e && e.postData && e.postData.contents || ''));
    } catch (_) {}
    return jsonOut({ ok: false, error: String(err) });
  }
}

/* ── Discount-code helpers ──────────────────────────────────────────────── */

// A code from an unambiguous alphabet (no 0/O/1/I), prefixed NGF-.
function genCode() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var s = '';
  for (var i = 0; i < 6; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return 'NGF-' + s;
}

// Generate a code not already present in the sheet (collisions are vanishingly
// rare, but loop a few times to be safe).
function generateUniqueCode(sheet) {
  for (var attempt = 0; attempt < 10; attempt++) {
    var code = genCode();
    if (!findDiscountByCode(sheet, code)) return code;
  }
  return genCode() + Date.now().toString(36).toUpperCase(); // last-resort uniqueness
}

// Find a discount row by email → { rowIndex, code, used } | null.
function findDiscountByEmail(sheet, email) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var norm = String(email).toLowerCase().trim();
  var width = Math.max(8, sheet.getLastColumn());
  var values = sheet.getRange(2, 1, last - 1, width).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][1]).toLowerCase().trim() === norm) {      // col 2 = Email
      return {
        rowIndex: i + 2,
        code: String(values[i][4] || '').toUpperCase().trim(),     // col 5 = Code
        used: String(values[i][5] || '').toLowerCase() === 'yes',  // col 6 = Used
        emailedAt: values[i][7]                                    // col 8 = Code Emailed At (Date | '')
      };
    }
  }
  return null;
}

// Find a discount row by code → { rowIndex, email, code, used, expiresAt, percent } | null.
// expiresAt is a Date for time-limited codes (recovery) and null for the
// evergreen popup codes; percent is null unless the row explicitly recorded one.
function findDiscountByCode(sheet, code) {
  var norm = String(code || '').toUpperCase().trim();
  if (!norm) return null;
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var width = Math.max(10, sheet.getLastColumn());
  var values = sheet.getRange(2, 1, last - 1, width).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][4] || '').toUpperCase().trim() === norm) { // col 5 = Code
      var exp = values[i][8];                                       // col 9 = Expires At
      var pct = parseInt(values[i][9], 10);                         // col 10 = Percent
      return {
        rowIndex: i + 2,
        email: String(values[i][1] || '').toLowerCase().trim(),     // col 2 = Email
        code: norm,
        used: String(values[i][5] || '').toLowerCase() === 'yes',   // col 6 = Used
        expiresAt: (exp instanceof Date) ? exp : (exp ? new Date(exp) : null),
        percent: (pct >= 1 && pct <= 100) ? pct : null
      };
    }
  }
  return null;
}

/**
 * Returns true if the email already exists in the discount tab.
 * Email comparison is case-insensitive and whitespace-trimmed.
 */
function discountEmailExists(sheet, email) {
  const last = sheet.getLastRow();
  if (last < 2) return false;
  const norm = String(email).toLowerCase().trim();
  const emails = sheet.getRange(2, 2, last - 1, 1).getValues();
  for (let i = 0; i < emails.length; i++) {
    if (String(emails[i][0]).toLowerCase().trim() === norm) return true;
  }
  return false;
}

/**
 * Returns true if the email exists in the Completed Orders tab.
 * Used by the members-area gate on the website to verify that a visitor is
 * a paying customer before exposing the download link to app.nogymforme.com.
 *
 * Completed Orders headers (see HEADERS.completed):
 *   ['Timestamp', 'Order #', 'Name', 'Email', 'Phone', 'Address', 'City', 'Plan', 'Total', 'User-Agent']
 *                                       ↑ column 4 (1-indexed)
 *
 * Case-insensitive + whitespace-trimmed, same as discountEmailExists.
 */
function completedEmailExists(sheet, email) {
  const last = sheet.getLastRow();
  if (last < 2) return false;
  const norm = String(email).toLowerCase().trim();
  if (!norm) return false;
  const emails = sheet.getRange(2, 4, last - 1, 1).getValues();
  for (let i = 0; i < emails.length; i++) {
    if (String(emails[i][0]).toLowerCase().trim() === norm) return true;
  }
  return false;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Resolves the active Sheet ID. Source of truth is Script Properties so a
 * future file paste-over with empty `SHEET_ID` doesn't destroy the config.
 *
 * Migration path: if the file-local SHEET_ID const is set but Script
 * Properties is empty, copy const→Properties on first call. After that one
 * call the file's const can be safely emptied again.
 */
function getSheetId() {
  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty('SHEET_ID');
  if (stored) return stored;
  if (SHEET_ID) {
    props.setProperty('SHEET_ID', SHEET_ID);
    return SHEET_ID;
  }
  return null;
}

function ensureSheet(ss, type) {
  const name = TABS[type];
  const headers = HEADERS[type];
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground(HEADER_BG);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, headers.length);
  } else if (sheet.getLastColumn() < headers.length) {
    // Migration: an existing tab is missing newer columns (e.g. the discount
    // tab gained Code/Used/Used At). Extend the header row so new appends stay
    // aligned; existing rows simply keep blank cells in the new columns.
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground(HEADER_BG);
  }
  return sheet;
}

function buildRow(type, d) {
  const ts = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  if (type === 'discount')  return [ts, d.email || '', d.source || 'popup', d._ua || '', d._code || '', 'No', ''];
  if (type === 'started')   return [ts, d.name || '', d.email || '', d.phone || '', d.plan || '', 'Abandoned', d._ua || '', d.address || '', d.city || '', d.comments || ''];
  if (type === 'completed') return [ts, d.orderNum || '', d.name || '', d.email || '', d.phone || '', d.address || '', d.city || '', d.plan || '', d.total || '', d._ua || '', d.comments || ''];
  if (type === 'appwait')   return [ts, d.email || '', d.source || 'ios', d._ua || ''];
  return [];
}

function promoteAbandonedToCompleted(ss, d) {
  const sheet = ss.getSheetByName(TABS.started);
  if (!sheet) return;
  const last = sheet.getLastRow();
  if (last < 2) return;
  const values = sheet.getRange(2, 1, last - 1, HEADERS.started.length).getValues();
  for (let i = 0; i < values.length; i++) {
    const rowEmail = String(values[i][2] || '').toLowerCase();
    const rowPhone = String(values[i][3] || '');
    const status   = String(values[i][5] || '');
    if (status === 'Abandoned' &&
        ((d.email && rowEmail === String(d.email).toLowerCase()) ||
         (d.phone && rowPhone === String(d.phone)))) {
      sheet.getRange(i + 2, 6).setValue('Completed');
      sheet.getRange(i + 2, 1, 1, HEADERS.started.length).setBackground('#C8E6C9'); // soft green
    }
  }
}

// Send a customer-facing email From the NOGYMFORME brand inbox.
// IMPORTANT: this uses GmailApp, not MailApp — MailApp silently ignores the
// `from` option, so it can't send as an alias (that's why earlier sends still
// showed davidkain1@gmail.com). GmailApp's `from` sends as a verified
// "Send mail as" alias of the account running the script (davidkain1@gmail.com),
// which must include NOTIFY_EMAIL. GmailApp needs a broader Gmail authorization
// scope, so the owner must RE-AUTHORIZE the script once after pasting this.
// If the alias/From is unavailable for any reason, we fall back to a plain
// MailApp send (From = owner, Reply-To still the brand inbox) so mail always
// goes out. Best-effort: never throws.
function sendCustomerEmail_(to, subject, htmlBody) {
  try {
    GmailApp.sendEmail(to, subject, '', {
      htmlBody: htmlBody,
      name: 'NOGYMFORME',
      from: NOTIFY_EMAIL,
      replyTo: NOTIFY_EMAIL
    });
  } catch (e) {
    try {
      MailApp.sendEmail({ to: to, subject: subject, htmlBody: htmlBody, name: 'NOGYMFORME', replyTo: NOTIFY_EMAIL });
    } catch (e2) { /* never break the caller */ }
  }
}

// Email the customer their personal discount code. Best-effort: a mail failure
// must never break the signup (the code is already saved + shown in the popup).
function sendCustomerCode(email, code) {
  if (!email || !code) return;
  var subject = 'קוד ההנחה שלך ל-NOGYMFORME 🎁';
  var html =
    '<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;' +
      'background:#0A0A0A;color:#ffffff;padding:32px 24px;border-radius:12px;text-align:center;">' +
      '<div style="font-size:22px;font-weight:900;color:#E8D900;letter-spacing:1px;">NOGYM' +
        '<span style="color:#ffffff;">FORME</span></div>' +
      '<h1 style="font-size:20px;margin:18px 0 8px;">קוד ההנחה שלך מוכן 🎉</h1>' +
      '<p style="color:#cfccc6;font-size:15px;line-height:1.6;margin:0 0 20px;">' +
        'הנה קוד ההנחה האישי שלך — <strong>10% הנחה</strong> על ההזמנה הראשונה. ' +
        'הזן אותו בעמוד התשלום עם כתובת המייל הזו.</p>' +
      '<div style="display:inline-block;background:#E8D900;color:#0A0A0A;font-family:monospace;' +
        'font-size:28px;font-weight:900;letter-spacing:3px;padding:14px 30px;border-radius:10px;">' +
        code + '</div>' +
      '<p style="color:#8a8680;font-size:13px;margin-top:22px;">הקוד אישי, חד-פעמי ותקף להזמנה אחת.</p>' +
    '</div>';
  sendCustomerEmail_(email, subject, html);
}

// Re-send the code email to a RETURNING visitor — but at most once per 24h per
// email. This gives the standard "switched device / cleared cache → get my code
// by email" recovery without burning the shared Gmail send quota. The last send
// time lives in col 8 (Code Emailed At) as a Date.
function maybeResendCode(sheet, rec, email) {
  if (!rec || !rec.code) return;
  var last = (rec.emailedAt instanceof Date) ? rec.emailedAt : null;
  var DAY_MS = 24 * 60 * 60 * 1000;
  if (last && (Date.now() - last.getTime()) < DAY_MS) return; // emailed < 24h ago → skip
  sendCustomerCode(email, rec.code);
  sheet.getRange(rec.rowIndex, 8).setValue(new Date());
}

/* ══════════════════════════════════════════════════════════════════════════
   ABANDONED-CART RECOVERY
   ══════════════════════════════════════════════════════════════════════════
   sendRecoveryEmails() is driven by a TIME-BASED TRIGGER (every 30 minutes),
   not by doPost. Install it once from the Apps Script editor:
     Triggers → Add Trigger → sendRecoveryEmails → Time-driven →
     Minutes timer → Every 30 minutes
   Until that trigger exists, nothing sends.

   Safety properties, in order of how much they'd cost you if they broke:
     1. Never emails anyone who completed an order  (double-checked: the row's
        own Status, AND a live lookup in Completed Orders).
     2. Never emails the same address twice, ever — one offer per address for
        the lifetime of the sheet.
     3. Never touches carts older than RECOVERY_MAX_AGE_HRS — which is what
        stops the very first run from blasting the historical backlog.
     4. Stops at RECOVERY_MAX_PER_RUN and at the real Gmail quota, and tells
        the operator rather than failing silently.
   ══════════════════════════════════════════════════════════════════════════ */

// Recovery codes look like BACK15-7F2K9. The prefix is what earns the 15% in
// api/create-payment.js — see RECOVERY_CODE_PREFIX above.
function genRecoveryCode() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1 — read aloud safely
  var s = '';
  for (var i = 0; i < 5; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return RECOVERY_CODE_PREFIX + s;
}

// Issue a personal, single-use, expiring code and record it in Discount Signups
// so the existing redeemCheck / markUsed machinery validates it unchanged.
// Returns { code, expiresAt }.
function issueRecoveryCode_(discountSheet, email, ua) {
  var code;
  for (var attempt = 0; attempt < 10; attempt++) {
    code = genRecoveryCode();
    if (!findDiscountByCode(discountSheet, code)) break;
  }
  var expiresAt = new Date(Date.now() + RECOVERY_EXPIRY_HOURS * 60 * 60 * 1000);
  var ts = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  // Column order must match HEADERS.discount exactly.
  discountSheet.appendRow([ts, String(email).toLowerCase().trim(), 'recovery', ua || '',
                           code, 'No', '', new Date(), expiresAt, RECOVERY_PERCENT]);
  return { code: code, expiresAt: expiresAt };
}

// True if this email address has EVER been sent a recovery email, for the whole
// lifetime of the sheet. The 15% code is a one-time win-back offer, not a
// standing discount someone can farm by abandoning a cart whenever they want
// money off — so one address gets one offer, permanently.
//
// Any non-empty value in the column counts, not just a parseable date: if that
// cell has something in it we treat the address as spent and skip. Failing
// closed is the right direction here — the cost of wrongly skipping someone is
// one unsent email, the cost of wrongly sending is an unlimited discount.
function alreadyRecovered_(startedValues, email) {
  var norm = String(email).toLowerCase().trim();
  for (var i = 0; i < startedValues.length; i++) {
    if (String(startedValues[i][2] || '').toLowerCase().trim() !== norm) continue;
    if (startedValues[i][10]) return true;                   // col 11 = Recovery Emailed At
  }
  return false;
}

function isOwnerEmail_(email) {
  var norm = String(email || '').toLowerCase().trim();
  for (var i = 0; i < OWNER_EMAILS.length; i++) {
    if (String(OWNER_EMAILS[i]).toLowerCase().trim() === norm) return true;
  }
  return false;
}

// The checkout's Name field is free text and never required (the abandon
// beacon only gates on email-OR-phone), so the sheet holds plenty of junk:
// test input, addresses pasted into the wrong box, stray keystrokes. Greeting
// someone "היי asdf," reads as broken automation and undercuts a letter whose
// whole job is to feel personal — so anything that doesn't look like a given
// name is dropped in favour of the perfectly good bare "היי,".
// Returns '' when the value isn't usable.
function recoveryGreetingName_(raw) {
  var first = String(raw || '').trim().split(/\s+/)[0] || '';   // given name only
  if (first.length < 2 || first.length > 20) return '';         // initials, or a pasted sentence
  if (/[@\d]/.test(first))                   return '';         // an email or phone in the wrong field
  return first;
}

// The recovery email itself. Copy is fixed by the brand; the greeting degrades
// to a bare "היי," whenever the checkout captured no usable name.
function recoveryEmailHtml_(name, code) {
  var clean    = recoveryGreetingName_(name);
  var greeting = clean ? ('היי ' + escapeHtml(clean) + ',') : 'היי,';
  var p = 'margin:0 0 16px;font-size:15px;line-height:1.8;color:#cfccc6;';
  return '' +
    '<div dir="rtl" lang="he" style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;' +
      'background:#0A0A0A;color:#ffffff;padding:32px 26px;border-radius:12px;text-align:right;">' +

      '<div style="font-size:22px;font-weight:900;color:#E8D900;letter-spacing:1px;text-align:center;">' +
        'NOGYM<span style="color:#ffffff;">FORME</span></div>' +

      '<p style="' + p + 'margin-top:26px;color:#ffffff;font-size:16px;">' + greeting + '</p>' +

      '<p style="' + p + '">שמנו לב שקפצת לביקור באתר שלנו, הוספת את החבילה לעגלה – ובסוף החלטת לחכות עם זה.</p>' +

      '<p style="' + p + '">אנחנו לגמרי מבינים את ההתלבטות. להוריד את הכרס זה תהליך, ובדיוק בגלל זה הקמנו את ' +
        'NOGYMFORME. המטרה שלנו היא לעזור לך להגיע לתוצאות, בלי להרגיש שצריך להשתעבד לחדר כושר. ' +
        'התוסף שבחרת נועד לתת לך בדיוק את הפוש הזה, בדרך קלה ונוחה שמשתלבת בשגרה שלך.</p>' +

      '<p style="' + p + '">כדי לעשות לך את ההחלטה קצת יותר קלה, החלטנו לתת לך הנחת חברים מיוחדת של ' +
        '<strong style="color:#E8D900;">15%</strong> על החבילה שמחכה לך.</p>' +

      '<p style="' + p + '">כל מה שצריך לעשות הוא להזין את קוד הקופון בקופה:</p>' +

      '<div style="text-align:center;margin:0 0 8px;">' +
        '<div style="display:inline-block;background:#E8D900;color:#0A0A0A;font-family:monospace;' +
          'font-size:26px;font-weight:900;letter-spacing:3px;padding:13px 28px;border-radius:10px;">' +
          escapeHtml(code) + '</div></div>' +
      '<p style="text-align:center;color:#8a8680;font-size:13px;margin:0 0 22px;">' +
        '(הקופון תקף ל-48 השעות הקרובות)</p>' +

      '<p style="' + p + 'text-align:center;">' +
        '<a href="' + RECOVERY_CART_URL + '" style="color:#E8D900;font-weight:bold;text-decoration:underline;">' +
          'לחץ/י כאן לחזרה לעגלה שלך ומימוש ההנחה.</a></p>' +

      '<div style="text-align:center;margin:22px 0 26px;">' +
        '<a href="' + RECOVERY_CART_URL + '" style="display:inline-block;background:#E8D900;color:#0A0A0A;' +
          'font-size:16px;font-weight:900;padding:14px 34px;border-radius:10px;text-decoration:none;">' +
          'חזרה לעגלה שלי ←</a></div>' +

      '<p style="' + p + '">אם יש לך שאלות על התוסף, איך הוא עובד או מתי רואים תוצאות – אנחנו כאן בשבילך. ' +
        'פשוט אפשר להשיב למייל הזה ונשמח לעזור.</p>' +

      '<p style="' + p + '">מחכים לראות אותך איתנו!</p>' +

      '<p style="' + p + 'margin-bottom:4px;">צוות NOGYMFORME</p>' +
      '<p style="margin:0;"><a href="https://www.nogymforme.com" style="color:#E8D900;font-size:14px;">' +
        'www.nogymforme.com</a></p>' +
    '</div>';
}

const RECOVERY_SUBJECT =
  'אין זמן למכון? אל תוותר על הכרס. העגלה שלך ב-NOGYMFORME מחכה (15% הנחה בפנים!)';

/**
 * Time-triggered sweep. Safe to run by hand and safe to run twice — every
 * recipient is stamped in the sheet before the next candidate is considered.
 * Returns a short summary string (handy when running it manually from the editor).
 */
function sendRecoveryEmails() {
  var sheetId = getSheetId();
  if (!sheetId) return 'not configured';
  var ss = SpreadsheetApp.openById(sheetId);
  var started = ss.getSheetByName(TABS.started);
  if (!started) return 'no abandoned tab';

  var discount  = ensureSheet(ss, 'discount');
  var completed = ss.getSheetByName(TABS.completed);

  var last = started.getLastRow();
  if (last < 2) return 'no rows';

  // ensureSheet() only widens the header row; make sure the DATA range we read
  // is wide enough to include the two new recovery columns even on a sheet
  // whose rows predate them.
  ensureSheet(ss, 'started');
  var width  = Math.max(HEADERS.started.length, started.getLastColumn());
  var values = started.getRange(2, 1, last - 1, width).getValues();

  var now      = Date.now();
  var minAge   = RECOVERY_MIN_AGE_MIN * 60 * 1000;
  var maxAge   = RECOVERY_MAX_AGE_HRS * 60 * 60 * 1000;
  var sent = 0, skipped = 0, capped = false;
  var sentThisRun = {};   // guards duplicates WITHIN a single run

  for (var i = 0; i < values.length; i++) {
    if (sent >= RECOVERY_MAX_PER_RUN) { capped = true; break; }

    var row     = values[i];
    var rowNum  = i + 2;
    var email   = String(row[2] || '').toLowerCase().trim();
    var name    = String(row[1] || '').trim();
    var status  = String(row[5] || '').trim();
    var alreadySent = row[10];                       // col 11 = Recovery Emailed At

    if (!email || email.indexOf('@') < 0) continue;  // no email → nothing to send to
    if (status !== 'Abandoned')           continue;  // already promoted to Completed
    if (alreadySent)                      continue;  // this row was handled before
    if (sentThisRun[email])               continue;
    if (isOwnerEmail_(email))             continue;  // team/test checkouts

    var ts = asDate_(row[0]);
    if (!ts) continue;
    var age = now - ts.getTime();
    if (age < minAge || age > maxAge) continue;      // too fresh, or out of scope

    // Belt-and-braces: promoteAbandonedToCompleted() matches on email OR phone
    // and can miss edge cases. Never send a discount to someone who already paid.
    if (completed && completedEmailExists(completed, email)) { skipped++; continue; }
    if (alreadyRecovered_(values, email))                    { skipped++; continue; }

    // Real quota, not just our own cap. GmailApp throws once exhausted, which
    // would abort the whole run mid-sweep and lose the stamping.
    if (MailApp.getRemainingDailyQuota() < 5) { capped = true; break; }

    var issued = issueRecoveryCode_(discount, email, String(row[6] || ''));
    sendCustomerEmail_(email, RECOVERY_SUBJECT, recoveryEmailHtml_(name, issued.code));

    // Stamp AFTER sending, so a crash mid-send retries rather than silently
    // skipping the customer forever.
    started.getRange(rowNum, 11).setValue(new Date());
    started.getRange(rowNum, 12).setValue(issued.code);
    sentThisRun[email] = true;
    sent++;
  }

  if (capped) {
    notifyOps_('⚠️ NGFM recovery emails hit the send cap',
      'sendRecoveryEmails stopped after ' + sent + ' sends (cap ' + RECOVERY_MAX_PER_RUN +
      ', Gmail quota left ' + MailApp.getRemainingDailyQuota() + '). ' +
      'Remaining carts will be picked up on the next run if still inside the ' +
      RECOVERY_MAX_AGE_HRS + 'h window.');
  }
  return 'sent ' + sent + ', skipped ' + skipped + (capped ? ', CAPPED' : '');
}

/**
 * ONE-OFF TEST. Run this from the Apps Script editor to send yourself the real
 * email with a real, redeemable code — without touching the Abandoned tab and
 * without waiting for the trigger. Change the address if you like.
 * The code it issues is genuine: you can spend it at checkout to verify 15%.
 */
function testRecoveryEmail() {
  var sheetId = getSheetId();
  if (!sheetId) throw new Error('Sheet not configured — set the script property first.');
  var ss = SpreadsheetApp.openById(sheetId);
  var discount = ensureSheet(ss, 'discount');

  var to = 'davidkain1@gmail.com';
  var issued = issueRecoveryCode_(discount, to, 'manual-test');
  sendCustomerEmail_(to, RECOVERY_SUBJECT, recoveryEmailHtml_('דוד', issued.code));
  Logger.log('Sent to %s — code %s, expires %s', to, issued.code,
             Utilities.formatDate(issued.expiresAt, TIMEZONE, 'yyyy-MM-dd HH:mm'));
  return issued.code;
}

// Branded order-confirmation email to the BUYER, sent once a payment is
// confirmed (the `completed` event). SUMIT separately emails the tax invoice/
// receipt; this is the friendly "we got your order" note with the shipping
// details we collected. Best-effort: a mail failure must never break the
// order recording.
function sendOrderConfirmation(d) {
  var email = String(d.email || '').trim();
  if (!email) return;

  var planName = PLAN_NAMES[d.plan] || d.plan || '';
  var rows = '';
  function row(label, value) {
    if (!value) return '';
    return '<tr><td style="padding:6px 0;color:#8a8680;font-size:14px">' + label + '</td>' +
           '<td style="padding:6px 0;color:#ffffff;font-size:14px;font-weight:600">' + escapeHtml(value) + '</td></tr>';
  }
  rows += row('הזמנה', planName);
  rows += row('מספר הזמנה', d.orderNum);
  rows += row('סכום', d.total);

  var shipping = '';
  if (d.address || d.city) {
    var line = [d.address, d.city].filter(function (x) { return x; }).join(', ');
    shipping =
      '<div style="text-align:right;background:#161616;border:1px solid #222;border-radius:10px;padding:16px 18px;margin:18px 0;">' +
        '<div style="color:#E8D900;font-size:13px;font-weight:700;margin-bottom:6px;">כתובת למשלוח</div>' +
        '<div style="color:#cfccc6;font-size:14px;line-height:1.6;">' + escapeHtml(line) +
        (d.comments ? '<br><span style="color:#8a8680;">הערות: ' + escapeHtml(d.comments) + '</span>' : '') +
        '</div>' +
      '</div>';
  }

  var html =
    '<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;' +
      'background:#0A0A0A;color:#ffffff;padding:32px 24px;border-radius:12px;text-align:center;">' +
      '<div style="font-size:22px;font-weight:900;color:#E8D900;letter-spacing:1px;">NOGYM' +
        '<span style="color:#ffffff;">FORME</span></div>' +
      '<h1 style="font-size:20px;margin:18px 0 8px;">ההזמנה שלך התקבלה! 🎉</h1>' +
      '<p style="color:#cfccc6;font-size:15px;line-height:1.6;margin:0 0 18px;">' +
        'תודה רבה על ההזמנה. קיבלנו את התשלום והמשלוח יוצא לדרך בימים הקרובים.</p>' +
      '<table style="width:100%;border-collapse:collapse;text-align:right;">' + rows + '</table>' +
      shipping +
      '<p style="color:#8a8680;font-size:13px;line-height:1.6;margin:18px 0 0;">' +
        'חשבונית/קבלה תישלח אליך בנפרד מחברת הסליקה SUMIT. ' +
        'יש שאלה? פשוט השב/י למייל הזה ונשמח לעזור.</p>' +
    '</div>';

  sendCustomerEmail_(email, 'ההזמנה שלך ב-NOGYMFORME התקבלה 🎉', html);
}

function sendNotification(type, d, ss) {
  const url = 'https://docs.google.com/spreadsheets/d/' + getSheetId() + '/export?format=xlsx';
  const blob = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
  }).getBlob().setName('NoGymForMe_Data.xlsx');

  const subject = subjectFor(type, d);
  const body = bodyFor(type, d);

  const mail = {
    to: NOTIFY_EMAIL,
    subject: subject,
    htmlBody: body,
    attachments: [blob]
  };
  // Loop a second person in on actual purchases only, so an order can't be
  // missed by a single inbox. Lead/popup events stay operator-only.
  if (type === 'completed' && ORDER_ALERT_CC) mail.cc = ORDER_ALERT_CC;
  MailApp.sendEmail(mail);
}

function subjectFor(type, d) {
  // Subject lines surface the most actionable info first so you can
  // triage the inbox without opening each email. For discount/waitlist
  // events, that means showing WHICH package the lead was on.
  if (type === 'discount') {
    return '🟡 NGFM — ' + labelForSource(d.source) + ' — ' + (d.email || '');
  }
  if (type === 'started') {
    return '🟠 NGFM abandoned cart — ' + planLabelFor_(d.plan) + ' — ' + (d.email || d.phone || '');
  }
  if (type === 'completed') {
    return '🟢 NGFM NEW ORDER — ' + (d.orderNum || '') + ' (' + (d.name || d.email || '') + ')';
  }
  if (type === 'appwait') {
    return '📲 NGFM app waitlist — ' + (d.email || '');
  }
  return 'NoGymForMe — event';
}

function bodyFor(type, d) {
  const rows = Object.keys(d).filter(function (k) { return k.charAt(0) !== '_' && k !== 'type'; })
    .map(function (k) { return '<tr><td style="padding:4px 12px 4px 0;color:#666">' + k + '</td><td style="padding:4px 0">' + escapeHtml(d[k] || '') + '</td></tr>'; })
    .join('');
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/' + getSheetId() + '/edit';
  const label = (type === 'discount') ? 'Discount / waitlist signup' :
                (type === 'started')  ? 'Abandoned checkout' :
                (type === 'appwait')  ? 'App download waitlist (iOS)' :
                'Completed order';

  // Big "which package?" callout at the top — replaces the need to scan
  // the data table to find which plan the lead was on.
  let packageCallout = '';
  if (type === 'discount' && d.source) {
    packageCallout =
      '<div style="background:#E8D900;color:#000;padding:14px 18px;border-radius:6px;margin:0 0 16px;font-size:18px;font-weight:bold">' +
      escapeHtml(labelForSource(d.source)) +
      '</div>';
  } else if (type === 'started' && d.plan) {
    packageCallout =
      '<div style="background:#FFE5B4;color:#000;padding:14px 18px;border-radius:6px;margin:0 0 16px;font-size:18px;font-weight:bold">' +
      escapeHtml(planLabelFor_(d.plan)) +
      '</div>';
  }

  return '<div style="font-family:Arial,sans-serif">' +
    '<h2 style="margin:0 0 12px">' + label + '</h2>' +
    packageCallout +
    '<p style="margin:0 0 12px;color:#444">A new event was just recorded. The new row is highlighted <span style="background:#FFF59D;padding:2px 8px">yellow</span> in the attached spreadsheet.</p>' +
    '<table style="border-collapse:collapse">' + rows + '</table>' +
    '<p style="margin-top:24px"><a href="' + sheetUrl + '" style="background:#E8D900;color:#000;padding:10px 18px;text-decoration:none;font-weight:bold">Open live sheet →</a></p>' +
    '</div>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
  });
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ════════════════════════════════════════════════════════════════════════════
   VIP SUBSCRIPTION — 90-DAY JOURNEY PRICING & EARLY-CANCELLATION SETTLE-UP
   Implements VIP-BILLING-SPEC.md. Additive: touches no existing function.

   ⚠️ SAFE MODE BY DEFAULT. This script is otherwise tracking-only and has no
   existing payment integration. The actual money charge is isolated in
   chargeSettleUpViaSummit_(). Until Script Properties SUMIT_COMPANY_ID +
   SUMIT_API_KEY are set (and the Summit customer/payment id is stored on the
   subscription), the handler records the exact owed amount and emails the
   operator to charge manually. It NEVER fakes or guesses a charge.

   All billing runs through Summit (UPAY is only Summit's underlying clearing
   gateway; we never call UPAY directly). Prerequisite plumbing (also here):
   vipSubscribe (store Summit customer/payment id at signup), vipCycle (record a
   successful monthly charge), and summitWebhook (Summit's recurring-payment
   webhook → vipCycle). See spec §9.
   ════════════════════════════════════════════════════════════════════════════ */

function ensureVipSheet_(which) {
  var ss = SpreadsheetApp.openById(getSheetId());
  var name = VIP_TABS[which];
  var headers = VIP_HEADERS[which];
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
         .setFontWeight('bold').setBackground(HEADER_BG);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastColumn() < headers.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
         .setFontWeight('bold').setBackground(HEADER_BG);
  }
  return sheet;
}

// Normalized one-per-customer key: email | phone(digits) | nationalId(digits).
function vipDedupKey_(email, phone, nationalId) {
  var e = String(email || '').toLowerCase().trim();
  var p = String(phone || '').replace(/\D/g, '');
  var n = String(nationalId || '').replace(/\D/g, '');
  return [e, p, n].join('|');
}

// Look up a subscription by subId (preferred), dedupKey, or email → parsed | null.
function findVipSub_(sheet, q) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var width = VIP_HEADERS.subs.length;
  var values = sheet.getRange(2, 1, last - 1, width).getValues();
  var wantId    = q.subId    ? String(q.subId).trim() : '';
  var wantKey   = q.dedupKey ? String(q.dedupKey).trim() : '';
  var wantEmail = q.email    ? String(q.email).toLowerCase().trim() : '';
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var match =
      (wantId    && String(r[VIP_COL.subId - 1]).trim() === wantId) ||
      (wantKey   && String(r[VIP_COL.dedupKey - 1]).trim() === wantKey) ||
      (wantEmail && String(r[VIP_COL.email - 1]).toLowerCase().trim() === wantEmail);
    if (match) return parseVipSubRow_(r, i + 2);
  }
  return null;
}

function parseVipSubRow_(r, rowIndex) {
  return {
    rowIndex:      rowIndex,
    subId:         String(r[VIP_COL.subId - 1] || '').trim(),
    name:          String(r[VIP_COL.name - 1] || ''),
    email:         String(r[VIP_COL.email - 1] || '').toLowerCase().trim(),
    phone:         String(r[VIP_COL.phone - 1] || ''),
    nationalId:    String(r[VIP_COL.nationalId - 1] || ''),
    dedupKey:      String(r[VIP_COL.dedupKey - 1] || '').trim(),
    summitCustomerId: String(r[VIP_COL.summitCustomerId - 1] || '').trim(),
    summitPaymentId:  String(r[VIP_COL.summitPaymentId - 1] || '').trim(),
    firstCharge:   asDate_(r[VIP_COL.firstCharge - 1]),
    firstDelivery: asDate_(r[VIP_COL.firstDelivery - 1]),
    cycles:        Number(r[VIP_COL.cycles - 1]) || 0,
    status:        String(r[VIP_COL.status - 1] || '').trim(),
    // startsWith "yes" so "Yes (prior sub)" / "Yes 2026-..." all count as used.
    guaranteeUsed: /^yes/i.test(String(r[VIP_COL.guaranteeUsed - 1] || '').trim()),
    cycleRefs:     String(r[VIP_COL.cycleRefs - 1] || '')
  };
}

/* ── vipSubscribe: store a new VIP subscriber + recurring token (idempotent) ── */
function handleVipSubscribe(d) {
  if (!getSheetId()) return jsonOut({ ok: false, error: 'not configured' });
  if (!d.subId)      return jsonOut({ ok: false, error: 'subId required' });
  var sheet = ensureVipSheet_('subs');
  var dedup = vipDedupKey_(d.email, d.phone, d.nationalId);

  var existing = findVipSub_(sheet, { subId: d.subId });
  if (existing) {
    if (d.summitCustomerId) sheet.getRange(existing.rowIndex, VIP_COL.summitCustomerId).setValue(d.summitCustomerId);
    if (d.summitPaymentId)  sheet.getRange(existing.rowIndex, VIP_COL.summitPaymentId).setValue(d.summitPaymentId);
    return jsonOut({ ok: true, alreadyExists: true, subId: d.subId });
  }

  // Inherit "guarantee already used" from any prior sub by the same customer
  // (E11: one money-back guarantee per customer, for life).
  var prior = findVipSub_(sheet, { dedupKey: dedup });
  var now = new Date();
  var row = new Array(VIP_HEADERS.subs.length).fill('');
  row[VIP_COL.subId - 1]         = d.subId;
  row[VIP_COL.created - 1]       = Utilities.formatDate(now, TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  row[VIP_COL.name - 1]          = d.name || '';
  row[VIP_COL.email - 1]         = String(d.email || '').toLowerCase().trim();
  row[VIP_COL.phone - 1]         = d.phone || '';
  row[VIP_COL.nationalId - 1]    = d.nationalId || '';
  row[VIP_COL.dedupKey - 1]      = dedup;
  row[VIP_COL.summitCustomerId - 1] = d.summitCustomerId || '';
  row[VIP_COL.summitPaymentId - 1]  = d.summitPaymentId || '';
  row[VIP_COL.firstCharge - 1]   = d.firstChargeDate ? new Date(d.firstChargeDate) : now;
  row[VIP_COL.firstDelivery - 1] = d.firstDeliveryDate ? new Date(d.firstDeliveryDate) : '';
  row[VIP_COL.cycles - 1]        = Number(d.cycles) || 0;
  row[VIP_COL.status - 1]        = 'active';
  row[VIP_COL.guaranteeUsed - 1] = prior ? 'Yes (prior sub)' : '';
  sheet.appendRow(row);
  return jsonOut({ ok: true, alreadyExists: false, subId: d.subId });
}

/* ── vipCycle: record a successful monthly charge (from billing webhook) ────── */
function handleVipCycle(d) {
  if (!getSheetId()) return jsonOut({ ok: false, error: 'not configured' });
  if (!d.subId)      return jsonOut({ ok: false, error: 'subId required' });
  var sheet = ensureVipSheet_('subs');
  var sub = findVipSub_(sheet, { subId: d.subId });
  if (!sub) return jsonOut({ ok: false, error: 'subscription not found' });

  // Idempotency: a retried/redelivered Summit webhook for the same payment must
  // not double-count a cycle (which would over-charge the clawback later).
  var ref = String(d.chargeRef || '').trim();
  if (ref && sub.cycleRefs.split('|').indexOf(ref) !== -1) {
    return jsonOut({ ok: true, idempotent: true, subId: d.subId, cycles: sub.cycles });
  }

  var now = new Date();
  var newCycles = sub.cycles + 1;            // one successful charge = one bottle
  sheet.getRange(sub.rowIndex, VIP_COL.cycles).setValue(newCycles);
  if (ref) {
    sheet.getRange(sub.rowIndex, VIP_COL.cycleRefs)
         .setValue(sub.cycleRefs ? (sub.cycleRefs + '|' + ref) : ref);
  }
  sheet.getRange(sub.rowIndex, VIP_COL.lastCharge)
       .setValue(Utilities.formatDate(now, TIMEZONE, 'yyyy-MM-dd HH:mm:ss'));
  if (!sub.firstCharge) sheet.getRange(sub.rowIndex, VIP_COL.firstCharge).setValue(now);
  if (d.deliveryDate && !sub.firstDelivery) {
    sheet.getRange(sub.rowIndex, VIP_COL.firstDelivery).setValue(new Date(d.deliveryDate));
  }
  // "Journey complete" = the moment the 3rd charge clears (spec E2).
  if (newCycles >= VIP.JOURNEY_CYCLES && sub.status === 'active') {
    sheet.getRange(sub.rowIndex, VIP_COL.status).setValue('journey_complete');
  }
  return jsonOut({ ok: true, subId: d.subId, cycles: newCycles });
}

/* ── vipCancel: THE cancellation handler. Idempotent on cancelTxnId (spec §3) ── */
function handleVipCancel(d) {
  if (!getSheetId()) return jsonOut({ ok: false, error: 'not configured' });
  var subsSheet = ensureVipSheet_('subs');
  var logSheet  = ensureVipSheet_('cancels');

  var sub = findVipSub_(subsSheet, {
    subId: d.subId,
    dedupKey: (d.email || d.phone || d.nationalId)
      ? vipDedupKey_(d.email, d.phone, d.nationalId) : '',
    email: d.email
  });
  if (!sub) return jsonOut({ ok: false, error: 'subscription not found' });

  // Idempotency (spec E12): one settle-up per cancelTxnId. A retry returns the
  // recorded outcome instead of charging again. Caller SHOULD pass cancelTxnId.
  var cancelTxnId = String(d.cancelTxnId || (sub.subId + '-' + new Date().getTime()));
  var prior = findCancelByTxn_(logSheet, cancelTxnId);
  if (prior) return jsonOut({ ok: true, idempotent: true, result: prior });

  // Ownership proof: require the one-time code emailed by vipCancelRequestOtp,
  // consumed on success so it can't be replayed. Placed AFTER the idempotency
  // check so a retried (already-processed) cancel still returns its recorded
  // result without needing a fresh code.
  var otpKey = vipOtpKey_(sub.email);
  var cache = CacheService.getScriptCache();
  var expectedOtp = cache.get(otpKey);
  var providedOtp = String(d.otp || '').trim();
  if (!providedOtp) return jsonOut({ ok: false, error: 'otp_required' });
  if (!expectedOtp || providedOtp !== expectedOtp) return jsonOut({ ok: false, error: 'otp_invalid' });
  cache.remove(otpKey);

  var now = new Date();
  var decision = computeVipCancellation_(sub, now);

  // Money movement. Refund (Step 1) is NOT auto-issued — the original charge
  // runs through Summit, so refunds are issued there; we record + alert.
  var charge = { mode: 'none', charged: false, txnId: '' };
  if (decision.clawback > 0) charge = chargeSettleUpViaSummit_(sub, decision.clawback);

  // Persist status + guarantee-used ledger.
  subsSheet.getRange(sub.rowIndex, VIP_COL.status)
           .setValue(decision.branch === 'journey_complete' ? 'completed_canceled' : 'canceled');
  if (decision.guaranteeApplied) {
    subsSheet.getRange(sub.rowIndex, VIP_COL.guaranteeUsed)
             .setValue('Yes ' + Utilities.formatDate(now, TIMEZONE, 'yyyy-MM-dd'));
  }

  var chargeStatus = decision.clawback === 0 ? '—'
    : (charge.charged ? 'charged'
       : (charge.mode === 'manual' ? 'PENDING (manual)' : 'FAILED'));
  logSheet.appendRow([
    Utilities.formatDate(now, TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
    sub.subId, sub.email, sub.dedupKey, decision.cycles,
    decision.branch, decision.guaranteeApplied ? 'Yes' : 'No',
    decision.refund, decision.clawback,
    chargeStatus, charge.txnId || '', cancelTxnId
  ]);

  notifyVipCancellation_(sub, decision, charge, chargeStatus);
  sendVipCancelCustomerEmail_(sub, decision);

  return jsonOut({ ok: true, idempotent: false, result: {
    branch: decision.branch, refund: decision.refund, clawback: decision.clawback,
    chargeStatus: chargeStatus, cancelTxnId: cancelTxnId
  }});
}

/* ── vipCancelRequestOtp: email a one-time code (step 1 of cancel) ──────────── */
function handleVipCancelRequestOtp(d) {
  if (!getSheetId()) return jsonOut({ ok: false, error: 'not configured' });
  var email = String(d.email || '').toLowerCase().trim();
  if (!email) return jsonOut({ ok: false, error: 'email required' });
  // Only mint a code for an email that actually has a VIP subscription.
  var sub = findVipSub_(ensureVipSheet_('subs'), { email: email });
  if (!sub) return jsonOut({ ok: true, sent: false });
  var code = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
  CacheService.getScriptCache().put(vipOtpKey_(email), code, 600); // 10-min TTL
  sendVipOtpEmail_(email, code);
  return jsonOut({ ok: true, sent: true });
}

function vipOtpKey_(email) { return 'vipotp_' + String(email || '').toLowerCase().trim(); }

function sendVipOtpEmail_(email, code) {
  var html =
    '<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;' +
      'background:#0A0A0A;color:#fff;padding:32px 24px;border-radius:12px;text-align:center;">' +
      '<div style="font-size:22px;font-weight:900;color:#E8D900;">NOGYM<span style="color:#fff;">FORME</span></div>' +
      '<h1 style="font-size:19px;margin:16px 0 8px;">קוד אימות לביטול מנוי</h1>' +
      '<p style="color:#cfccc6;font-size:15px;line-height:1.6;margin:0 0 18px;">' +
        'הזן את הקוד כדי לאשר את ביטול מנוי ה-VIP. הקוד תקף ל-10 דקות. ' +
        'אם לא ביקשת לבטל - אפשר להתעלם מהמייל הזה.</p>' +
      '<div style="display:inline-block;background:#E8D900;color:#0A0A0A;font-family:monospace;' +
        'font-size:30px;font-weight:900;letter-spacing:6px;padding:14px 28px;border-radius:10px;">' +
        code + '</div>' +
    '</div>';
  try {
    MailApp.sendEmail({ to: email, subject: 'קוד אימות לביטול מנוי NOGYMFORME', htmlBody: html, name: 'NOGYMFORME' });
  } catch (e) {}
}

/* ── Pure decision logic (spec §3). No side effects — directly unit-testable. ── */
function computeVipCancellation_(sub, now) {
  var diff = vipDiff();                          // ₪43
  var cycles = sub.cycles;                       // successful charges = bottles shipped
  var totalCharged = cycles * VIP.MONTHLY;

  // Step 0: guarantee anchor = delivery date, else first charge + 5d fallback.
  var anchor = sub.firstDelivery ? sub.firstDelivery
             : (sub.firstCharge ? addDays_(sub.firstCharge, VIP.SHIPPING_FALLBACK_DAYS) : null);
  // Day 14 inclusive → compare against the END of the deadline day.
  var withinGuarantee = !!anchor &&
      now.getTime() <= endOfDay_(addDays_(anchor, VIP.GUARANTEE_DAYS)).getTime();

  // Step 1: guarantee wins — but only once per customer (E11).
  if (withinGuarantee && !sub.guaranteeUsed) {
    return { branch: 'guarantee_refund', guaranteeApplied: true, refund: totalCharged, clawback: 0, cycles: cycles };
  }
  // Step 3: journey complete → discount earned, clean ₪0 exit.
  if (cycles >= VIP.JOURNEY_CYCLES) {
    return { branch: 'journey_complete', guaranteeApplied: false, refund: 0, clawback: 0, cycles: cycles };
  }
  // Step 2: early cancel → settle up at regular price for bottles shipped.
  return { branch: 'early_settle_up', guaranteeApplied: false, refund: 0, clawback: cycles * diff, cycles: cycles };
}

/* ── Summit (SUMIT/OfficeGuy) saved-method charge for the early-cancellation
   settle-up. All billing runs through Summit; UPAY is only Summit's underlying
   clearing gateway and is never called directly.
   Endpoint: POST https://api.sumit.co.il/billing/payments/charge/
   Auth: Credentials { CompanyID, APIKey } from Script Properties
   (SUMIT_COMPANY_ID, SUMIT_API_KEY). Charges the customer's stored Summit
   payment method (captured at signup) for `amount` ILS. OfficeGuy response
   envelope: Status === 0 means success; UserErrorMessage holds the failure.

   SAFE MODE: if creds or the saved Summit ids are missing, it returns mode
   'manual' (charged:false) so the caller records the owed amount and emails you
   to charge manually — it never fabricates a transaction.

   ⚠️ CONFIRM the exact body field names (Items / PaymentMethodID) against your
   Summit account (app.sumit.co.il → developers) before enabling live charges.
   Field names here follow the documented OfficeGuy charge shape. ───────────── */
function chargeSettleUpViaSummit_(sub, amount) {
  var props = PropertiesService.getScriptProperties();
  var companyId = props.getProperty('SUMIT_COMPANY_ID');
  var apiKey    = props.getProperty('SUMIT_API_KEY');

  if (!companyId || !apiKey || !sub.summitCustomerId) {
    return { ok: true, charged: false, mode: 'manual',
             reason: (!companyId || !apiKey) ? 'Summit not configured (safe mode)'
                                             : 'missing Summit customer/payment id on subscription' };
  }
  var body = {
    Credentials: { CompanyID: companyId, APIKey: apiKey },
    Customer: { ID: sub.summitCustomerId },
    // Charge the saved payment method captured at signup. If you instead rely on
    // the customer's DEFAULT method in Summit, you can drop PaymentMethodID.
    PaymentMethodID: sub.summitPaymentId || null,
    Items: [{
      Quantity: 1,
      UnitPrice: amount,
      Description: 'השלמת מחיר VIP — מעבר למחיר רגיל (' + sub.cycles + ' בקבוקים)'
    }],
    VATIncluded: true,
    SendDocumentByEmail: true
  };
  try {
    var resp = UrlFetchApp.fetch('https://api.sumit.co.il/billing/payments/charge/', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    var r = JSON.parse(resp.getContentText() || '{}');
    var ok = (r.Status === 0);   // OfficeGuy: 0 = success
    var pay = (r.Data && (r.Data.Payment || r.Data.payment)) || {};
    return { ok: ok, charged: ok, mode: 'summit',
             txnId: pay.ID || (r.Data && r.Data.DocumentID) || '',
             code: String(r.Status), error: r.UserErrorMessage || '', raw: r };
  } catch (err) {
    return { ok: false, charged: false, mode: 'summit', error: String(err) };
  }
}

/* ── small utilities ───────────────────────────────────────────────────────── */
function findCancelByTxn_(sheet, cancelTxnId) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var width = VIP_HEADERS.cancels.length;
  var values = sheet.getRange(2, 1, last - 1, width).getValues();
  var want = String(cancelTxnId).trim();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][width - 1]).trim() === want) {
      return { branch: values[i][5], refund: values[i][7], clawback: values[i][8],
               chargeStatus: values[i][9], cancelTxnId: want };
    }
  }
  return null;
}
function addDays_(date, n) { var x = new Date(date.getTime()); x.setDate(x.getDate() + n); return x; }
function endOfDay_(date) { var x = new Date(date.getTime()); x.setHours(23, 59, 59, 999); return x; }
function asDate_(v) { return (v instanceof Date) ? v : (v ? new Date(v) : null); }

/* ── notifications ─────────────────────────────────────────────────────────── */
function notifyVipCancellation_(sub, decision, charge, chargeStatus) {
  var lines = [
    'VIP cancellation processed.',
    'Sub: ' + sub.subId + '  |  ' + sub.name + '  |  ' + sub.email,
    'Bottles shipped (cycles): ' + decision.cycles,
    'Branch: ' + decision.branch,
    'Refund owed: ₪' + decision.refund,
    'Clawback: ₪' + decision.clawback + '  (' + chargeStatus + ')'
  ];
  if (decision.branch === 'guarantee_refund') {
    lines.push('', '➡️ ACTION: issue a FULL REFUND of ₪' + decision.refund + ' via Summit.');
  } else if (decision.clawback > 0 && charge.mode === 'manual') {
    lines.push('', '➡️ ACTION: charge ₪' + decision.clawback +
               ' manually (' + (charge.reason || 'safe mode') + ').');
  } else if (decision.clawback > 0 && !charge.charged) {
    lines.push('', '🚨 ACTION: clawback charge FAILED (code ' +
               (charge.code || charge.error || '?') + '). Retry ₪' + decision.clawback + ' manually.');
  }
  try {
    MailApp.sendEmail({ to: NOTIFY_EMAIL, cc: ORDER_ALERT_CC || '',
      subject: '♻️ NGFM VIP cancel — ' + decision.branch + ' — ' + (sub.email || sub.subId),
      body: lines.join('\n') });
  } catch (e) {}
}

function sendVipCancelCustomerEmail_(sub, decision) {
  if (!sub.email) return;
  var diff = vipDiff();
  var subject, intro, detail;
  if (decision.branch === 'guarantee_refund') {
    subject = 'ביטול מנוי ה-VIP — החזר כספי מלא בדרך אליך';
    intro   = 'ביטלת בתוך 14 הימים הראשונים, אז אתה מכוסה באחריות החזר כספי מלא.';
    detail  = 'נחזיר לך את מלוא הסכום ששילמת (₪' + decision.refund + '). אין שום חיוב הפרש.';
  } else if (decision.branch === 'journey_complete') {
    subject = 'סיימת את מסע ה-90 יום 💪';
    intro   = 'כל הכבוד — השלמת את המסע המלא.';
    detail  = 'אין שום חיוב נוסף, וההנחה של 21% שלך נשמרת. תודה שהיית חלק מ-NOGYMFORME.';
  } else { // early_settle_up
    subject = 'ביטול מנוי ה-VIP — עדכון חיוב';
    intro   = 'עצרת לפני שהשלמת את 90 הימים, אז המחיר על מה שכבר קיבלת מתעדכן למחיר הרגיל.';
    detail  = 'קיבלת ' + decision.cycles + ' בקבוקים. ההפרש למחיר הרגיל (₪' + diff +
              ' לבקבוק) מסתכם ב-₪' + decision.clawback + '. זה הכל — בלי קנסות.';
  }
  var html =
    '<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;' +
      'background:#0A0A0A;color:#fff;padding:32px 24px;border-radius:12px;text-align:center;">' +
      '<div style="font-size:22px;font-weight:900;color:#E8D900;">NOGYM<span style="color:#fff;">FORME</span></div>' +
      '<h1 style="font-size:19px;margin:16px 0 10px;">' + escapeHtml(subject) + '</h1>' +
      '<p style="color:#cfccc6;font-size:15px;line-height:1.6;margin:0 0 14px;">' + escapeHtml(intro) + '</p>' +
      '<p style="color:#cfccc6;font-size:15px;line-height:1.6;margin:0;">' + escapeHtml(detail) + '</p>' +
    '</div>';
  try {
    MailApp.sendEmail({ to: sub.email, subject: subject, htmlBody: html, name: 'NOGYMFORME' });
  } catch (e) {}
}

/* ── Summit recurring-payment webhook → record a monthly cycle ───────────────
   Summit posts here on each successful recurring charge. The field names below
   are the common OfficeGuy shape; because webhook payloads vary by account, any
   payload we CAN'T match to a subscriber is emailed to you raw (notifyOps_) so
   you can confirm the exact keys for YOUR account and tighten the mapping.
   This handler only RECORDS cycles — it never charges. vipCycle is idempotent
   on the Summit payment ref, so redelivered webhooks won't double-count. ───── */
function handleSummitWebhook_(data) {
  if (!getSheetId()) return jsonOut({ ok: false, error: 'not configured' });

  // Defensive extraction — CONFIRM against a real Summit webhook payload.
  var customerId = data.CustomerID || (data.Customer && data.Customer.ID) || '';
  var email      = data.EmailAddress || (data.Customer && data.Customer.EmailAddress) || data.email || '';
  var chargeRef  = String(data.PaymentID || data.ID || data.TransactionID || '').trim();
  var deliveryDate = data.DeliveryDate || '';   // usually absent; set by courier feed
  var paymentOk  = (data.ValidPayment === true) || (data.Status === 0) ||
                   /paid|success|charged|approved/i.test(String(data.PaymentStatus || data.EventType || data.Type || ''));

  var subsSheet = ensureVipSheet_('subs');
  var sub = findVipSubBySummit_(subsSheet, customerId, email);

  if (!sub) {
    // Unknown subscriber — don't guess. Alert with the raw payload so it can be
    // reconciled (and so you can see the real Summit field names once).
    notifyOps_('Summit webhook — unmatched VIP subscriber',
               'customerId=' + customerId + '  email=' + email + '\n\n' + JSON.stringify(data));
    return jsonOut({ ok: true, matched: false });
  }
  if (!paymentOk) {
    return jsonOut({ ok: true, matched: true, counted: false, reason: 'not a successful payment event' });
  }
  // Count one cycle (idempotent on chargeRef).
  return handleVipCycle({ subId: sub.subId, deliveryDate: deliveryDate, chargeRef: chargeRef });
}

// Find a VIP subscription by Summit customer id (preferred) or email.
function findVipSubBySummit_(sheet, customerId, email) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var values = sheet.getRange(2, 1, last - 1, VIP_HEADERS.subs.length).getValues();
  var wantCust  = String(customerId || '').trim();
  var wantEmail = String(email || '').toLowerCase().trim();
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    if ((wantCust  && String(r[VIP_COL.summitCustomerId - 1]).trim() === wantCust) ||
        (wantEmail && String(r[VIP_COL.email - 1]).toLowerCase().trim() === wantEmail)) {
      return parseVipSubRow_(r, i + 2);
    }
  }
  return null;
}

// Best-effort operator alert (never throws).
function notifyOps_(subject, body) {
  try {
    MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: '⚠️ NGFM — ' + subject, body: body });
  } catch (e) {}
}
