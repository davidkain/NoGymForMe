/**
 * NoGymForMe — "Completed Orders" → App access sync
 * ==================================================
 *
 * Runs every 5 minutes, scans the "Completed Orders" sheet for rows that have
 * not been synced yet, and POSTs each new buyer's email + plan to the app so
 * they land in the AllowedCustomer allowlist and can register immediately.
 *
 * Lives in the standalone "NGFM Tracker" project and reuses its SHEET_ID
 * property. Runs alongside — and never touches — the existing order code.
 */

var SHEET_NAME = 'Completed Orders'
var EMAIL_COL = 4 // Column D
var PLAN_COL = 8 // Column H
var STATUS_COL = 12 // Column L
var FIRST_DATA_ROW = 2 // Row 1 = headers

function syncCompletedOrders() {
  var lock = LockService.getScriptLock()
  if (!lock.tryLock(10000)) return

  try {
    var props = PropertiesService.getScriptProperties()
    var url = props.getProperty('APP_WEBHOOK_URL')
    var secret = props.getProperty('ORDERS_WEBHOOK_SECRET')
    var sheetId = props.getProperty('SHEET_ID')
    if (!url || !secret) {
      throw new Error('Missing APP_WEBHOOK_URL or ORDERS_WEBHOOK_SECRET in Script properties')
    }
    if (!sheetId) {
      throw new Error('Missing SHEET_ID in Script properties')
    }

    var sheet = SpreadsheetApp.openById(sheetId).getSheetByName(SHEET_NAME)
    if (!sheet) throw new Error('Sheet tab not found: ' + SHEET_NAME)

    var lastRow = sheet.getLastRow()
    if (lastRow < FIRST_DATA_ROW) return

    var numRows = lastRow - FIRST_DATA_ROW + 1
    var emails = sheet.getRange(FIRST_DATA_ROW, EMAIL_COL, numRows, 1).getValues()
    var plans = sheet.getRange(FIRST_DATA_ROW, PLAN_COL, numRows, 1).getValues()
    var status = sheet.getRange(FIRST_DATA_ROW, STATUS_COL, numRows, 1).getValues()

    for (var i = 0; i < numRows; i++) {
      var row = FIRST_DATA_ROW + i
      if (String(status[i][0]).trim() !== '') continue

      var email = String(emails[i][0]).trim()
      var plan = String(plans[i][0]).trim()

      if (email === '' && plan === '') continue
      if (email === '' || email.indexOf('@') === -1) {
        writeStatus(sheet, row, 'Error: missing/invalid email')
        continue
      }
      if (plan === '') {
        writeStatus(sheet, row, 'Error: missing plan')
        continue
      }

      var result = postOrder(url, secret, email, plan)
      if (result.ok) {
        writeStatus(sheet, row, 'Synced ✓ ' + timestamp())
      } else if (result.retriable) {
        Logger.log('Row ' + row + ' transient failure (' + result.code + '): ' + result.body)
      } else {
        writeStatus(sheet, row, 'Error: ' + result.code + ' ' + result.body)
      }
    }
  } finally {
    lock.releaseLock()
  }
}

function postOrder(url, secret, email, plan) {
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Webhook-Secret': secret },
    payload: JSON.stringify({ email: email, plan: plan }),
    muteHttpExceptions: true,
  }
  try {
    var resp = UrlFetchApp.fetch(url, options)
    var code = resp.getResponseCode()
    var body = resp.getContentText()
    if (code >= 200 && code < 300) return { ok: true }
    var retriable = code >= 500 || code === 429
    return { ok: false, retriable: retriable, code: code, body: truncate(body) }
  } catch (e) {
    return { ok: false, retriable: true, code: 0, body: String(e) }
  }
}

function writeStatus(sheet, row, text) {
  sheet.getRange(row, STATUS_COL, 1, 1).setValue(text)
}

function timestamp() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
}

function truncate(s) {
  s = String(s || '')
  return s.length > 120 ? s.slice(0, 120) : s
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncCompletedOrders') {
      ScriptApp.deleteTrigger(t)
    }
  })
  ScriptApp.newTrigger('syncCompletedOrders').timeBased().everyMinutes(5).create()
  Logger.log('Installed 5-minute trigger for syncCompletedOrders')
}