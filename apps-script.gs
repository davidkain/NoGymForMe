/**
 * NoGymForMe — tracking endpoint
 *
 * Receives POSTs from the website, writes a row to the right tab of the
 * configured Google Sheet, highlights the new row yellow, and emails
 * davidkain1@gmail.com a notification with the full sheet attached as XLSX.
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
const NOTIFY_EMAIL = 'davidkain1@gmail.com';
const TIMEZONE = 'Asia/Jerusalem';

const TABS = {
  discount:  'Discount Signups',
  started:   'Abandoned Checkouts',
  completed: 'Completed Orders'
};

const HEADERS = {
  discount:  ['Timestamp', 'Email', 'Source', 'User-Agent'],
  started:   ['Timestamp', 'Name', 'Email', 'Phone', 'Plan', 'Status', 'User-Agent'],
  completed: ['Timestamp', 'Order #', 'Name', 'Email', 'Phone', 'Address', 'City', 'Plan', 'Total', 'User-Agent']
};

const HEADER_BG = '#E8D900';   // brand gold
const HIGHLIGHT_BG = '#FFF59D'; // soft yellow for newly added rows

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

// ─── ENTRY POINTS ────────────────────────────────────────────────────────────
function doGet() {
  var id = getSheetId();
  return jsonOut({ ok: !!id, ping: 'NoGymForMe tracker alive', configured: !!id });
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const type = data.type;

    // ── READ-ONLY: members-area email verification ─────────────────────────
    // Special branch BEFORE the TABS check, because `verify` doesn't write
    // anything — it just answers "is this email in Completed Orders?".
    if (type === 'verify') {
      const sheetId = getSheetId();
      if (!sheetId) return jsonOut({ ok: false, error: 'not configured' });
      const ss = SpreadsheetApp.openById(sheetId);
      const sheet = ss.getSheetByName(TABS.completed);
      // No tab yet = no completed orders yet = no one is a verified customer.
      if (!sheet) return jsonOut({ ok: true, verified: false });
      return jsonOut({ ok: true, verified: completedEmailExists(sheet, data.email || '') });
    }

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
      if (discountEmailExists(sheet, data.email)) {
        return jsonOut({ ok: true, alreadyExists: true });
      }
    }

    const row = buildRow(type, data);
    sheet.appendRow(row);

    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow, 1, 1, row.length).setBackground(HIGHLIGHT_BG);

    // If a completed order arrives, mark earlier "Abandoned" rows for the same
    // email/phone as Completed so the abandoned tab doesn't lie.
    if (type === 'completed') promoteAbandonedToCompleted(ss, data);

    sendNotification(type, data, ss);

    return jsonOut({ ok: true, alreadyExists: false });
  } catch (err) {
    // Best-effort error log; never throw to the client.
    try {
      MailApp.sendEmail(NOTIFY_EMAIL, 'NGFM tracker error', String(err) + '\n\n' + (e && e.postData && e.postData.contents || ''));
    } catch (_) {}
    return jsonOut({ ok: false, error: String(err) });
  }
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
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    const headers = HEADERS[type];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground(HEADER_BG);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, headers.length);
  }
  return sheet;
}

function buildRow(type, d) {
  const ts = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  if (type === 'discount')  return [ts, d.email || '', d.source || 'popup', d._ua || ''];
  if (type === 'started')   return [ts, d.name || '', d.email || '', d.phone || '', d.plan || '', 'Abandoned', d._ua || ''];
  if (type === 'completed') return [ts, d.orderNum || '', d.name || '', d.email || '', d.phone || '', d.address || '', d.city || '', d.plan || '', d.total || '', d._ua || ''];
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

function sendNotification(type, d, ss) {
  const url = 'https://docs.google.com/spreadsheets/d/' + getSheetId() + '/export?format=xlsx';
  const blob = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
  }).getBlob().setName('NoGymForMe_Data.xlsx');

  const subject = subjectFor(type, d);
  const body = bodyFor(type, d);

  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    subject: subject,
    htmlBody: body,
    attachments: [blob]
  });
}

function subjectFor(type, d) {
  // Subject lines surface the most actionable info first so you can
  // triage the inbox without opening each email. For discount/waitlist
  // events, that means showing WHICH package the lead was on.
  if (type === 'discount') {
    return '🟡 NGFM — ' + labelForSource(d.source) + ' — ' + (d.email || '');
  }
  if (type === 'started') {
    var planLabel = d.plan ? labelForSource('waitlist_' + d.plan) : '(no plan)';
    return '🟠 NGFM abandoned — ' + planLabel + ' — ' + (d.email || d.phone || '');
  }
  if (type === 'completed') {
    return '🟢 NGFM NEW ORDER — ' + (d.orderNum || '') + ' (' + (d.name || d.email || '') + ')';
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
      escapeHtml(labelForSource('waitlist_' + d.plan)) +
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
