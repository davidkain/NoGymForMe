/**
 * NoGymForMe — tracking endpoint
 *
 * Receives POSTs from the website, writes a row to the right tab of the
 * configured Google Sheet, highlights the new row yellow, and emails
 * davidkain1@gmail.com a notification with the full sheet attached as XLSX.
 *
 * Setup:
 *   1) Create a new Google Sheet you own. Note its ID (the long string in
 *      the URL between /d/ and /edit).
 *   2) script.google.com → New project → paste THIS file's contents.
 *   3) Set SHEET_ID below.
 *   4) Deploy → New deployment → type "Web app" → execute as "Me",
 *      access "Anyone". Copy the deployment URL.
 *   5) Paste that URL into tracking.js → CONFIG.URL.
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const SHEET_ID = '';                          // ← paste your Sheet ID here
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

// ─── ENTRY POINTS ────────────────────────────────────────────────────────────
function doGet() {
  return jsonOut({ ok: true, ping: 'NoGymForMe tracker alive' });
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const type = data.type;
    if (!TABS[type]) return jsonOut({ ok: false, error: 'unknown type' });

    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ensureSheet(ss, type);
    const row = buildRow(type, data);
    sheet.appendRow(row);

    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow, 1, 1, row.length).setBackground(HIGHLIGHT_BG);

    // If a completed order arrives, mark earlier "Abandoned" rows for the same
    // email/phone as Completed so the abandoned tab doesn't lie.
    if (type === 'completed') promoteAbandonedToCompleted(ss, data);

    sendNotification(type, data, ss);

    return jsonOut({ ok: true });
  } catch (err) {
    // Best-effort error log; never throw to the client.
    try {
      MailApp.sendEmail(NOTIFY_EMAIL, 'NGFM tracker error', String(err) + '\n\n' + (e && e.postData && e.postData.contents || ''));
    } catch (_) {}
    return jsonOut({ ok: false, error: String(err) });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
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
  const url = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/export?format=xlsx';
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
  if (type === 'discount')  return '🟡 NoGymForMe — discount signup: ' + (d.email || '');
  if (type === 'started')   return '🟠 NoGymForMe — abandoned checkout: ' + (d.email || d.phone || '');
  if (type === 'completed') return '🟢 NoGymForMe — NEW ORDER: ' + (d.orderNum || '') + ' (' + (d.name || d.email || '') + ')';
  return 'NoGymForMe — event';
}

function bodyFor(type, d) {
  const rows = Object.keys(d).filter(function (k) { return k.charAt(0) !== '_' && k !== 'type'; })
    .map(function (k) { return '<tr><td style="padding:4px 12px 4px 0;color:#666">' + k + '</td><td style="padding:4px 0">' + escapeHtml(d[k] || '') + '</td></tr>'; })
    .join('');
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit';
  const label = (type === 'discount') ? 'Discount signup' :
                (type === 'started')  ? 'Abandoned checkout' :
                'Completed order';
  return '<div style="font-family:Arial,sans-serif">' +
    '<h2 style="margin:0 0 12px">' + label + '</h2>' +
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
