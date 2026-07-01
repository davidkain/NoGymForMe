/**
 * lib/discount-codes.js — shared discount-code → percent registry.
 *
 * Used by BOTH:
 *   - api/create-payment.js   → decides the actual charged price (source of truth)
 *   - api/payment-callback.js → Meta CAPI purchase value (analytics only)
 *
 * Only ONE `code` string is ever accepted per order (see create-payment.js),
 * so two discounts can never combine — applying a new code always REPLACES
 * any previously-applied one. This map exists purely to decide WHICH percent
 * a given (already-validated) code grants, never to decide validity.
 *
 * STATIC_DISCOUNT_CODES: fixed, non-personalized promo codes — not tied to a
 * customer email, not single-use. Keep in sync with STATIC_DISCOUNT_CODES in
 * apps-script.gs (that file owns validity for these codes via redeemCheck).
 *
 * DEFAULT_PERCENT: percent granted by the popup-issued, per-email, single-use
 * codes (validated against the "Discount Signups" sheet). Keep in sync with
 * DISCOUNT_PERCENT in apps-script.gs.
 */

'use strict';

const STATIC_DISCOUNT_CODES = {
  FRIENDS15: 15,
};

const DEFAULT_PERCENT = 10;

// Percent granted by a given (already-validated) code. Codes are matched
// case-insensitively; anything not in STATIC_DISCOUNT_CODES falls back to
// DEFAULT_PERCENT, which is correct for popup-issued codes.
function discountPercentFor(code) {
  const upper = String(code || '').trim().toUpperCase();
  return STATIC_DISCOUNT_CODES[upper] || DEFAULT_PERCENT;
}

module.exports = { STATIC_DISCOUNT_CODES, DEFAULT_PERCENT, discountPercentFor };
