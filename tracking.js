/**
 * NoGymForMe — lightweight event tracking (popup signups, started checkouts,
 * completed orders). Posts to a Google Apps Script web app that writes to a
 * Google Sheet and emails the owner.
 *
 * IMPORTANT: card / payment data is intentionally never passed through here.
 * The send() function only forwards a fixed set of allowed fields, so even if
 * a caller accidentally hands in `cardNumber` it will be silently dropped.
 */
(function (global) {
  // ─────────────────────────────────────────────────────────────────────────
  // CONFIG — paste the Apps Script Web App URL between the quotes.
  // (See TRACKING-SETUP.md for how to get this URL.)
  // ─────────────────────────────────────────────────────────────────────────
  var CONFIG = {
    URL: '' // e.g. 'https://script.google.com/macros/s/AKfy.../exec'
  };

  // Fields the tracker will EVER forward. Anything else is dropped.
  var ALLOWED = {
    discount:  ['email', 'source'],
    started:   ['name', 'email', 'phone', 'plan'],
    completed: ['orderNum', 'name', 'email', 'phone', 'address', 'city', 'plan', 'total']
  };

  function pick(obj, keys) {
    var out = {};
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (obj && obj[k] != null) out[k] = String(obj[k]).slice(0, 500); // hard length cap
    }
    return out;
  }

  function send(type, data, useBeacon) {
    if (!CONFIG.URL) return; // not configured yet — fail silent so the UI never breaks
    var allowed = ALLOWED[type];
    if (!allowed) return;

    var payload = pick(data || {}, allowed);
    payload.type = type;
    payload._ua = (navigator.userAgent || '').slice(0, 200);
    payload._ts = Date.now();

    var body = JSON.stringify(payload);
    var ctype = 'text/plain;charset=utf-8'; // avoids CORS preflight on Apps Script

    try {
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon(CONFIG.URL, new Blob([body], { type: ctype }));
        return;
      }
      fetch(CONFIG.URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': ctype },
        body: body,
        keepalive: true
      }).catch(function () {});
    } catch (e) { /* never break the page over tracking */ }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────
  global.NGFMTrack = {
    discount: function (email) {
      send('discount', { email: email, source: 'popup' });
    },

    /** call when user fills email/phone on order form (non-blocking) */
    started: function (data) {
      send('started', data);
    },

    /** call once on successful submit */
    completed: function (data) {
      send('completed', data);
    },

    /** internal: send a started event using sendBeacon (page closing) */
    _startedBeacon: function (data) {
      send('started', data, true);
    },

    /** Wire up an order-form abandonment watcher.
     *
     * @param getSnapshot fn returning current {name,email,phone,plan} or null
     * @param wasCompleted fn returning true if order already submitted
     */
    watchAbandon: function (getSnapshot, wasCompleted) {
      var lastSentSig = '';
      function trySend(useBeacon) {
        if (wasCompleted && wasCompleted()) return;
        var snap = getSnapshot();
        if (!snap) return;
        // Only count as "started" if at least email or phone is filled.
        if (!snap.email && !snap.phone) return;
        var sig = (snap.email || '') + '|' + (snap.phone || '');
        if (sig === lastSentSig) return;
        lastSentSig = sig;
        send('started', snap, !!useBeacon);
      }

      // Send a "started" record once they've typed an email/phone
      // (not on every keystroke — only on blur).
      document.addEventListener('blur', function (e) {
        if (!e.target || !e.target.matches) return;
        if (e.target.matches('input[type=email], input[type=tel], input[name=email], input[name=phone], #email, #phone')) {
          trySend(false);
        }
      }, true);

      // Final flush on page hide — works on iOS Safari where 'beforeunload' is unreliable.
      window.addEventListener('pagehide', function () { trySend(true); });
      window.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') trySend(true);
      });
    }
  };
})(window);
