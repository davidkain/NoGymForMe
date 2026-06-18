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
    URL: 'https://script.google.com/macros/s/AKfycbwBmCaPLs3cFn2zvJw4vuMoFypgigvDIJbPuLxnLTebWOISz5o892F_H0gLtBtFvfn5/exec'
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
    discount: function (email, source) {
      send('discount', { email: email, source: source || 'popup' });
    },

    /**
     * Like discount(), but reads the response so callers can branch on
     * whether the email was already on file. Used by the popup to show
     * the "אחי, כבר קיבלת" message for returning visitors on a new device
     * (where the client-side localStorage check would miss them).
     *
     * Fails open: any error (network, CORS, Apps Script down, timeout)
     * resolves with { ok: false, alreadyExists: false } so the caller
     * can fall through to the regular success flow — better to give a
     * returning visitor a second coupon code than to block them with
     * an error message.
     *
     * @param {string}   email
     * @param {string}   [source]    free-form tag stored alongside the email
     * @param {function({ ok: boolean, alreadyExists: boolean, error?: string }): void} callback
     * @param {number}   [timeoutMs] default 3500ms
     */
    discountCheck: function (email, source, callback, timeoutMs) {
      if (!CONFIG.URL) { callback({ ok: false, alreadyExists: false, error: 'not configured' }); return; }

      var payload = {
        type:   'discount',
        email:  String(email || '').slice(0, 500),
        source: source || 'popup',
        _ua:    (navigator.userAgent || '').slice(0, 200),
        _ts:    Date.now()
      };

      var done = false;
      function finish(resp) { if (done) return; done = true; callback(resp); }

      // Hard timeout — Apps Script can be slow under cold-start.
      // Fail open so a slow server never blocks the popup UX.
      setTimeout(function () { finish({ ok: false, alreadyExists: false, error: 'timeout' }); }, timeoutMs || 3500);

      try {
        fetch(CONFIG.URL, {
          method:  'POST',
          mode:    'cors', // need to read the response — note send() uses no-cors
          headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // text/plain avoids CORS preflight
          body:    JSON.stringify(payload),
          keepalive: true
        })
          .then(function (r) { return r.json(); })
          .then(function (json) { finish({ ok: !!(json && json.ok), alreadyExists: !!(json && json.alreadyExists), code: (json && json.code) || '' }); })
          .catch(function (err) { finish({ ok: false, alreadyExists: false, error: String(err) }); });
      } catch (e) {
        finish({ ok: false, alreadyExists: false, error: String(e) });
      }
    },

    /**
     * Members-area gate: check whether the given email exists in the
     * Completed Orders tab (i.e. the visitor is a paying customer).
     *
     * Unlike send()/discount(), this is a read-only call — Apps Script
     * never appends a row. Same response shape as discountCheck so callers
     * get a stable contract.
     *
     * FAILS CLOSED (verified=false) on network/timeout errors, because for a
     * security-adjacent gate it's safer to ask the user to retry than to
     * accidentally grant access when the backend is silent. Contrast with
     * discountCheck which fails OPEN (a slow server shouldn't block a coupon).
     *
     * @param {string}   email
     * @param {function({ ok: boolean, verified: boolean, error?: string }): void} callback
     * @param {number}   [timeoutMs] default 4000ms (Apps Script cold-start tolerance)
     */
    verifyMember: function (email, callback, timeoutMs) {
      if (!CONFIG.URL) { callback({ ok: false, verified: false, error: 'not configured' }); return; }

      var payload = {
        type:  'verify',
        email: String(email || '').slice(0, 500),
        _ua:   (navigator.userAgent || '').slice(0, 200),
        _ts:   Date.now()
      };

      var done = false;
      function finish(resp) { if (done) return; done = true; callback(resp); }

      setTimeout(function () { finish({ ok: false, verified: false, error: 'timeout' }); }, timeoutMs || 4000);

      try {
        fetch(CONFIG.URL, {
          method:  'POST',
          mode:    'cors',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body:    JSON.stringify(payload),
          keepalive: true
        })
          .then(function (r) { return r.json(); })
          .then(function (json) { finish({ ok: !!(json && json.ok), verified: !!(json && json.verified) }); })
          .catch(function (err) { finish({ ok: false, verified: false, error: String(err) }); });
      } catch (e) {
        finish({ ok: false, verified: false, error: String(e) });
      }
    },

    /**
     * Validate a discount code at checkout. Read-only — never marks the code
     * used (that happens server-side only after a confirmed payment).
     *
     * FAILS CLOSED (valid:false) on network/timeout, so a code is never treated
     * as valid unless the server confirms it — matching the "block & explain"
     * rule (we'd rather tell the user to retry than apply an unverified code).
     *
     * @param {function({ ok:boolean, valid:boolean, percent:number, reason:string }): void} callback
     */
    validateCode: function (code, email, callback, timeoutMs) {
      if (!CONFIG.URL) { callback({ ok: false, valid: false, reason: 'notconfigured' }); return; }
      var payload = {
        type:  'redeemCheck',
        code:  String(code || '').slice(0, 40),
        email: String(email || '').slice(0, 150),
        _ua:   (navigator.userAgent || '').slice(0, 200),
        _ts:   Date.now()
      };
      var done = false;
      function finish(resp) { if (done) return; done = true; callback(resp); }
      setTimeout(function () { finish({ ok: false, valid: false, reason: 'timeout' }); }, timeoutMs || 5000);
      try {
        fetch(CONFIG.URL, {
          method:  'POST',
          mode:    'cors',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body:    JSON.stringify(payload),
          keepalive: true
        })
          .then(function (r) { return r.json(); })
          .then(function (j) { finish({ ok: !!(j && j.ok), valid: !!(j && j.valid), percent: (j && j.percent) || 0, reason: (j && j.reason) || '' }); })
          .catch(function (err) { finish({ ok: false, valid: false, reason: String(err) }); });
      } catch (e) {
        finish({ ok: false, valid: false, reason: String(e) });
      }
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
