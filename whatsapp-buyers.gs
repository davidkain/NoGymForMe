/**
 * Completed Orders → vCard (.vcf) export.
 *
 * Reads the "Completed Orders" sheet (Name = column 3, Phone = column 5),
 * normalizes Israeli phone numbers to +972 E.164, dedupes returning buyers by
 * phone, builds a standard vCard 3.0 string, saves it as a .vcf file in Google
 * Drive, and logs the file URL. No messaging, no API calls, no webhooks.
 *
 * Run: exportCompletedOrdersVCard()
 */

// Leave '' to reuse the tracker's already-configured spreadsheet (getSheetId()).
// Or paste a spreadsheet ID to target a specific sheet.
var VCARD_SHEET_ID = '';

var VCARD_SHEET_NAME = 'Completed Orders';
var VCARD_COL_NAME   = 3;  // column C
var VCARD_COL_PHONE  = 5;  // column E

function exportCompletedOrdersVCard() {
  var sheet = vcardSpreadsheet_().getSheetByName(VCARD_SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + VCARD_SHEET_NAME + '" not found.');

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('No data rows in "' + VCARD_SHEET_NAME + '".'); return; }

  // Read Name + Phone columns for every data row (row 2 .. lastRow).
  var width = Math.max(VCARD_COL_NAME, VCARD_COL_PHONE);
  var rows  = sheet.getRange(2, 1, lastRow - 1, width).getValues();

  var seen  = {};   // dedupe key = normalized phone
  var cards = [];
  var skippedInvalid = 0, skippedDupes = 0;

  for (var i = 0; i < rows.length; i++) {
    var name  = String(rows[i][VCARD_COL_NAME - 1] || '').trim();
    var phone = normalizeIsraeliPhone_(rows[i][VCARD_COL_PHONE - 1]);
    if (!phone) { skippedInvalid++; Logger.log('SKIPDIAG order='+rows[i][1]+' name='+name+' raw=['+rows[i][4]+'] type='+(typeof rows[i][4])); continue; } // blank / unparseable number
    if (seen[phone]) { skippedDupes++;   continue; } // returning buyer → keep once
    seen[phone] = true;

    var displayName = name || phone;   // fall back to the number if the name is blank
    cards.push(
      'BEGIN:VCARD\r\n' +
      'VERSION:3.0\r\n' +
      'N:' + vcardEscape_(displayName) + ';;;;\r\n' +
      'FN:' + vcardEscape_(displayName) + '\r\n' +
      'TEL;TYPE=CELL:' + phone + '\r\n' +   // already +972 E.164, no escaping needed
      'END:VCARD'
    );
  }

  if (!cards.length) { Logger.log('No rows with a valid phone number were found.'); return; }

  var vcf  = cards.join('\r\n') + '\r\n';
  var file = DriveApp.createFile('completed-orders.vcf', vcf, 'text/vcard');

  Logger.log(cards.length + ' unique contacts written (skipped ' + skippedDupes +
             ' duplicate, ' + skippedInvalid + ' without a valid phone). File URL: ' + file.getUrl());
  showResultDialog_(cards.length + ' unique contacts exported.\n' + skippedInvalid + ' skipped for an invalid phone, ' + skippedDupes + ' duplicate.', file.getUrl());
  return file.getUrl();
}

/**
 * Israeli phone → E.164 '+972…'. Handles 0-prefixed local (0501234567),
 * already-international (+972…, 00972…, 972…) and bare national (501234567).
 * Returns '' for blank / implausible input so bad rows are skipped, not written.
 */
function normalizeIsraeliPhone_(raw) {
  if (!raw && raw !== 0) return '';
  var d = String(raw).replace(/[^0-9]/g, '');   // digits only
  if (!d) return '';
  if (d.indexOf('00') === 0)  d = d.slice(2);    // 00 international prefix
  if (d.indexOf('972') === 0) d = d.slice(3);    // country code
  if (d.charAt(0) === '0')    d = d.slice(1);     // national trunk 0
  if (d.length < 8 || d.length > 9) return '';    // IL national number is 8–9 digits
  return '+972' + d;
}

/**
 * Diagnostic: logs the Completed Orders rows whose phone is blank or does not
 * normalize to a valid +972 number — i.e. the rows the export skips. Read-only.
 * Run: findSkippedOrders()
 */
function findSkippedOrders() {
  var sheet = vcardSpreadsheet_().getSheetByName(VCARD_SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + VCARD_SHEET_NAME + '" not found.');
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('No data rows.'); return []; }

  // Read Timestamp | Order # | Name | Email | Phone (cols 1..5).
  var rows = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  var skipped = [];
  for (var i = 0; i < rows.length; i++) {
    if (normalizeIsraeliPhone_(rows[i][VCARD_COL_PHONE - 1])) continue; // valid → not skipped
    skipped.push('Sheet row ' + (i + 2) +
      '  | Order #: ' + rows[i][1] +
      '  | Name: '    + rows[i][2] +
      '  | Email: '   + rows[i][3] +
      '  | Raw phone: "' + rows[i][4] + '"');
  }
  Logger.log(skipped.length ? (skipped.length + ' skipped row(s):\n' + skipped.join('\n'))
                            : 'No skipped rows.');
  return skipped;
}

/** Open the spreadsheet however this project is wired. */
function vcardSpreadsheet_() {
  if (VCARD_SHEET_ID) return SpreadsheetApp.openById(VCARD_SHEET_ID);
  if (typeof getSheetId === 'function') return SpreadsheetApp.openById(getSheetId());
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('Set VCARD_SHEET_ID at the top of the file to your spreadsheet ID.');
}

/** Escape vCard-special characters ( \ , ; and newlines ) per RFC 6350. */
function vcardEscape_(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/,/g,  '\\,')
    .replace(/;/g,  '\\;')
    .replace(/\r?\n/g, '\\n');
}


/** Adds the "NoGymForMe Tools" menu when the sheet opens (via the installed trigger). */
function onOpen(e) {
  SpreadsheetApp.getUi()
    .createMenu('NoGymForMe Tools')
    .addItem('Export WhatsApp Contacts', 'exportCompletedOrdersVCard')
    .addToUi();
}

/** ONE-TIME SETUP: run once to install the onOpen menu trigger on the sheet. Safe to re-run. */
function installSheetMenu() {
  var ss = vcardSpreadsheet_();
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'onOpen') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('onOpen').forSpreadsheet(ss).onOpen().create();
  return 'Installed. Reload the sheet to see the "NoGymForMe Tools" menu.';
}

/** Shows the export result (count + clickable VCF link) as a modal in the Sheet. Headless runs skip the UI. */
function showResultDialog_(message, url) {
  var ui;
  try { ui = SpreadsheetApp.getUi(); } catch (err) { return; }
  var m = String(message).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  var u = String(url).replace(/"/g,'&quot;');
  var html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;padding:6px 4px;">' +
      '<p style="white-space:pre-line;margin:0 0 14px;">' + m + '</p>' +
      '<a href="' + u + '" target="_blank" rel="noopener" style="display:inline-block;background:#25D366;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold;">Open VCF file</a>' +
      '<p style="word-break:break-all;color:#666;font-size:12px;margin:14px 0 0;">' + u + '</p>' +
    '</div>'
  ).setWidth(440).setHeight(210);
  ui.showModalDialog(html, 'WhatsApp Contacts Exported');
}
