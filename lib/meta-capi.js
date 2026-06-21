/**
 * lib/meta-capi.js — shared Meta Conversions API (CAPI) sender.
 *
 * Used by BOTH:
 *   - api/payment-callback.js  → primary server-side Purchase (verified payment)
 *   - api/meta-capi-purchase.js → thin HTTP route (browser fallback / webhooks)
 *
 * sendPurchaseEvent() NEVER throws — it returns a plain result object so callers
 * can decide what to do without try/catch. Reads META_PIXEL_ID / META_CAPI_TOKEN
 * from the environment. PII (email/phone/name) is SHA-256 hashed before sending,
 * per Meta's privacy requirement; raw PII is never transmitted.
 *
 * docs: https://developers.facebook.com/docs/marketing-api/conversions-api
 */

'use strict';

const crypto = require('crypto');

// Pin the Graph API version so Meta can't silently change behaviour on us.
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';

// The single product this store sells — keeps the CAPI content_* fields stable
// regardless of which plan/quantity the customer bought.
const PRODUCT_NAME = 'NoGymForMe - 90 Capsules';
const PRODUCT_ID = process.env.META_PRODUCT_ID || 'nogymforme-90-capsules';

// SHA-256 hex of a normalized string. Returns undefined for empty input so the
// field is omitted entirely (Meta rejects empty/whitespace hashes).
function sha256(normalized) {
  if (!normalized) return undefined;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Email: trim + lower-case.
function hashEmail(email) {
  return sha256(String(email || '').trim().toLowerCase());
}

// Phone: digits only, no +, no spaces/dashes, INCLUDING the country code. This
// store is Israel-first, so a local number beginning with 0 (e.g. 052-123-4567)
// is converted to its country form (972521234567) to maximise Meta's match
// rate. Override the default country code via META_DEFAULT_COUNTRY_CODE.
function hashPhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return undefined;
  const cc = process.env.META_DEFAULT_COUNTRY_CODE || '972';
  if (digits.startsWith('0')) digits = cc + digits.slice(1);
  return sha256(digits);
}

// Name fields: trim + lower-case, then hash.
function hashName(name) {
  return sha256(String(name || '').trim().toLowerCase());
}

// Drop undefined/empty keys so we never send empty PII or hint fields to Meta.
function compact(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') out[k] = obj[k];
  }
  return out;
}

/**
 * Build + send a "Purchase" event to Meta CAPI. Never throws.
 *
 * @param {object} input
 * @param {number} input.value            order total (required, > 0)
 * @param {string} [input.currency]       ISO code, defaults to 'ILS'
 * @param {string} [input.email]          raw email (hashed here)
 * @param {string} [input.phone]          raw phone (hashed here)
 * @param {string} [input.firstName]      raw first name (hashed here)
 * @param {string} [input.lastName]       raw last name (hashed here)
 * @param {string} [input.fbp]            _fbp cookie value
 * @param {string} [input.fbc]            _fbc cookie value
 * @param {string} [input.clientIp]       customer IP (non-hashed)
 * @param {string} [input.userAgent]      customer UA (non-hashed)
 * @param {string} [input.eventId]        dedup id shared with the browser Pixel
 * @param {string} [input.eventSourceUrl] page URL the purchase happened on
 * @param {string} [input.orderId]        your order/payment id
 * @param {number} [input.quantity]       units bought (defaults to 1)
 * @param {string} [input.testEventCode]  Events Manager → Test Events code
 * @returns {Promise<{ok:boolean, error?:string, events_received?:number, fbtrace_id?:string, status?:number, data?:any}>}
 */
async function sendPurchaseEvent(input) {
  input = input || {};

  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token) {
    console.error('[meta-capi] Missing META_PIXEL_ID and/or META_CAPI_TOKEN');
    return { ok: false, error: 'CAPI not configured' };
  }

  const value = Number(input.value);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: 'Missing or invalid `value`' };
  }
  const currency = String(input.currency || 'ILS').toUpperCase();

  if (!input.eventId) {
    console.warn('[meta-capi] No event_id supplied — browser/server dedup disabled');
  }

  const userData = compact({
    em: hashEmail(input.email),
    ph: hashPhone(input.phone),
    fn: hashName(input.firstName),
    ln: hashName(input.lastName),
    // Non-hashed signals Meta uses as-is for attribution:
    client_ip_address: input.clientIp,
    client_user_agent: input.userAgent,
    fbp: input.fbp,
    fbc: input.fbc,
  });

  const event = compact({
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000), // unix seconds, must be <=7 days old
    event_id: input.eventId,
    event_source_url: input.eventSourceUrl,
    action_source: 'website',
    user_data: userData,
    custom_data: {
      currency,
      value: Math.round(value * 100) / 100, // 2dp number, NOT a string
      content_name: PRODUCT_NAME,
      content_type: 'product',
      contents: [{ id: PRODUCT_ID, quantity: Number(input.quantity) || 1 }],
      order_id: input.orderId ? String(input.orderId) : undefined,
    },
  });

  const payload = { data: [event] };
  const testCode = input.testEventCode || process.env.META_TEST_EVENT_CODE;
  if (testCode) payload.test_event_code = String(testCode);

  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pixelId)}` +
    `/events?access_token=${encodeURIComponent(token)}`;

  // Hard timeout so a slow Meta never holds the request open (and never blocks
  // the customer's redirect from payment-callback.js).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const metaRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    const data = await metaRes.json().catch(() => null);

    if (!metaRes.ok) {
      console.error('[meta-capi] Meta rejected the event:', JSON.stringify(data));
      return { ok: false, error: 'Meta rejected the event', status: metaRes.status, data };
    }

    return {
      ok: true,
      events_received: data && data.events_received,
      fbtrace_id: data && data.fbtrace_id,
    };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    console.error('[meta-capi] CAPI call failed' + (aborted ? ' (timeout)' : '') + ':', err);
    return { ok: false, error: aborted ? 'Meta timeout' : 'CAPI request failed' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendPurchaseEvent };
