/**
 * lib/tiktok-events.js — shared TikTok Events API (server-side) sender.
 *
 * The TikTok counterpart to lib/meta-capi.js. Used by:
 *   - api/payment-callback.js → server-side CompletePayment (verified payment)
 *
 * sendCompletePaymentEvent() NEVER throws — it returns a plain result object so
 * callers can decide what to do without try/catch. Reads TIKTOK_PIXEL_ID /
 * TIKTOK_ACCESS_TOKEN from the environment; when either is missing the sender
 * is INERT (returns {ok:false, skipped:true}) so deploying this before the env
 * vars exist is a no-op rather than an error.
 *
 * PII (email/phone) is SHA-256 hashed before sending, per TikTok's requirement;
 * raw PII is never transmitted.
 *
 * docs: https://business-api.tiktok.com/portal/docs?id=1771101303251458
 */

'use strict';

const crypto = require('crypto');

// Pin the API version so TikTok can't silently change behaviour on us.
const API_VERSION = process.env.TIKTOK_API_VERSION || 'v1.3';
const ENDPOINT = `https://business-api.tiktok.com/open_api/${API_VERSION}/event/track/`;

// The single product this store sells — keeps content_* fields stable
// regardless of which plan/quantity the customer bought.
const PRODUCT_NAME = 'NoGymForMe - 90 Capsules';
const PRODUCT_ID = process.env.TIKTOK_PRODUCT_ID || 'nogymforme-90-capsules';

// SHA-256 hex of a normalized string. Returns undefined for empty input so the
// field is omitted entirely rather than sent as a hash of "".
function sha256(normalized) {
  if (!normalized) return undefined;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Email: trim + lower-case, then hash.
function hashEmail(email) {
  return sha256(String(email || '').trim().toLowerCase());
}

// Phone: TikTok wants E.164 (leading +, country code) BEFORE hashing — this is
// the one place the normalization differs from Meta, which wants digits only.
// Israel-first store, so a local number starting 0 (052-123-4567) becomes
// +972521234567. Override the default country code via TIKTOK_DEFAULT_COUNTRY_CODE.
function hashPhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return undefined;
  const cc = process.env.TIKTOK_DEFAULT_COUNTRY_CODE || '972';
  if (digits.startsWith('0')) digits = cc + digits.slice(1);
  return sha256('+' + digits);
}

// Drop undefined/empty keys so we never send empty PII or hint fields.
function compact(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') out[k] = obj[k];
  }
  return out;
}

/**
 * Build + send a "CompletePayment" event to the TikTok Events API. Never throws.
 *
 * @param {object} input
 * @param {number} input.value            order total (required, > 0)
 * @param {string} [input.currency]       ISO code, defaults to 'ILS'
 * @param {string} [input.email]          raw email (hashed here)
 * @param {string} [input.phone]          raw phone (hashed here)
 * @param {string} [input.ttp]            _ttp cookie value (TikTok browser id)
 * @param {string} [input.ttclid]         TikTok click id (ttclid URL param / cookie)
 * @param {string} [input.clientIp]       customer IP (non-hashed)
 * @param {string} [input.userAgent]      customer UA (non-hashed)
 * @param {string} [input.eventId]        dedup id shared with the browser Pixel
 * @param {string} [input.eventSourceUrl] page URL the purchase happened on
 * @param {string} [input.orderId]        your order/payment id
 * @param {number} [input.quantity]       units bought (defaults to 1)
 * @param {string} [input.testEventCode]  Events Manager → Test Events code
 * @returns {Promise<{ok:boolean, skipped?:boolean, error?:string, code?:number, message?:string, requestId?:string, status?:number}>}
 */
async function sendCompletePaymentEvent(input) {
  input = input || {};

  const pixelId = process.env.TIKTOK_PIXEL_ID;
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  // INERT when unconfigured: this ships before the env vars exist, and a missing
  // token must never look like a failed purchase.
  if (!pixelId || !token) {
    console.warn('[tiktok-events] TIKTOK_PIXEL_ID/TIKTOK_ACCESS_TOKEN not set — skipping (inert)');
    return { ok: false, skipped: true, error: 'TikTok Events API not configured' };
  }

  const value = Number(input.value);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: 'Missing or invalid `value`' };
  }
  const currency = String(input.currency || 'ILS').toUpperCase();

  if (!input.eventId) {
    console.warn('[tiktok-events] No event_id supplied — browser/server dedup disabled');
  }

  const user = compact({
    email: hashEmail(input.email),
    phone: hashPhone(input.phone),
    // Non-hashed signals TikTok uses as-is for attribution:
    ttp: input.ttp,
    ttclid: input.ttclid,
    ip: input.clientIp,
    user_agent: input.userAgent,
  });

  const event = compact({
    event: 'CompletePayment',
    event_time: Math.floor(Date.now() / 1000), // unix SECONDS
    event_id: input.eventId,
    user,
    page: input.eventSourceUrl ? { url: input.eventSourceUrl } : undefined,
    properties: {
      content_type: 'product',
      currency,
      value: Math.round(value * 100) / 100, // 2dp number, NOT a string
      contents: [{
        content_id: PRODUCT_ID,
        content_name: PRODUCT_NAME,
        quantity: Number(input.quantity) || 1,
        price: Math.round(value * 100) / 100,
      }],
      order_id: input.orderId ? String(input.orderId) : undefined,
    },
  });

  const payload = {
    event_source: 'web',
    event_source_id: pixelId,
    data: [event],
  };
  const testCode = input.testEventCode || process.env.TIKTOK_TEST_EVENT_CODE;
  if (testCode) payload.test_event_code = String(testCode);

  // Hard timeout so a slow TikTok never holds the request open (and never blocks
  // the customer's redirect from payment-callback.js).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const ttRes = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Access-Token': token,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    const data = await ttRes.json().catch(() => null);

    if (!ttRes.ok) {
      console.error('[tiktok-events] HTTP error from TikTok:', ttRes.status, JSON.stringify(data));
      return { ok: false, error: 'TikTok rejected the event', status: ttRes.status };
    }

    // CRITICAL: TikTok returns HTTP 200 even when it refuses the event — success
    // is signalled by code === 0 in the BODY. Checking only the HTTP status is
    // how a broken token or a wrong pixel id silently "succeeds" forever.
    const code = data && typeof data.code !== 'undefined' ? Number(data.code) : null;
    if (code !== 0) {
      console.error(
        `[tiktok-events] TikTok refused the event (code=${code}, message=${data && data.message}) ` +
        `— check TIKTOK_ACCESS_TOKEN belongs to pixel ${pixelId}`
      );
      return {
        ok: false,
        error: 'TikTok refused the event',
        code: code === null ? undefined : code,
        message: data && data.message,
      };
    }

    return {
      ok: true,
      code,
      message: data && data.message,
      requestId: data && data.request_id,
    };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    console.error('[tiktok-events] Events API call failed' + (aborted ? ' (timeout)' : '') + ':', err);
    return { ok: false, error: aborted ? 'TikTok timeout' : 'Events API request failed' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendCompletePaymentEvent };
