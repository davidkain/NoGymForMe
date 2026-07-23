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
    started:   ['name', 'email', 'phone', 'plan', 'address', 'city', 'comments'],
    completed: ['orderNum', 'name', 'email', 'phone', 'address', 'city', 'comments', 'plan', 'total']
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
      setTimeout(function () { finish({ ok: false, alreadyExists: false, error: 'timeout' }); }, timeoutMs || 12000);

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
     * App-download waitlist: store an email so we can notify the person when the
     * iOS app reopens after its update. Writes a row to the "App Waitlist (iOS)"
     * tab via the `appwait` Apps Script type and emails the team — no discount
     * code is minted (that path is scoped to `discount` only).
     *
     * Reads the JSON response so the page can confirm the email actually landed
     * (vs. the fire-and-forget `discount()`), falling back to ok:false on
     * network/timeout so the UI can offer a retry instead of a false success.
     *
     * @param {string}   email
     * @param {string}   [source] where the signup came from (default 'ios')
     * @param {function({ ok: boolean, error?: string }): void} callback
     * @param {number}   [timeoutMs] default 10000ms (Apps Script cold-start tolerance)
     */
    appWaitlist: function (email, source, callback, timeoutMs) {
      callback = callback || function () {};
      if (!CONFIG.URL) { callback({ ok: false, error: 'not configured' }); return; }

      var payload = {
        type:   'appwait',
        email:  String(email || '').slice(0, 500),
        source: String(source || 'ios').slice(0, 100),
        _ua:    (navigator.userAgent || '').slice(0, 200),
        _ts:    Date.now()
      };

      var done = false;
      function finish(resp) { if (done) return; done = true; callback(resp); }

      setTimeout(function () { finish({ ok: false, error: 'timeout' }); }, timeoutMs || 10000);

      try {
        fetch(CONFIG.URL, {
          method:  'POST',
          mode:    'cors',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body:    JSON.stringify(payload),
          keepalive: true
        })
          .then(function (r) { return r.json(); })
          .then(function (json) { finish({ ok: !!(json && json.ok) }); })
          .catch(function (err) { finish({ ok: false, error: String(err) }); });
      } catch (e) {
        finish({ ok: false, error: String(e) });
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
     * Fires a "started" beacon for a shopper who has entered an email/phone and
     * then LEAVES the page (closes the tab, navigates away, or switches away)
     * without completing — so the operator gets their contact details to follow
     * up.
     *
     * @param getSnapshot  fn returning current {name,email,phone,plan,...} or null
     * @param wasCompleted fn returning true once the order was submitted (Pay
     *                     clicked) — suppresses the leave-flush on the redirect
     *                     to the payment page, which is not an abandonment.
     * @param opts         { onBlur?: boolean } — when true, ALSO fire the instant
     *                     an email/phone field is blurred (more eager capture,
     *                     but noisier). Defaults to leave-only (balanced).
     */
    watchAbandon: function (getSnapshot, wasCompleted, opts) {
      /* Dedupe state — deliberately NOT the contact signature.
         Keying on email+phone meant a shopper who typed their email, glanced at
         another app, came back, typed their phone and glanced away again sent
         TWO events and earned TWO owner alerts: the signature had changed, so
         the guard waved it through. It also lived in a plain variable, so any
         reload re-armed it from scratch.

         The rule now: at most one send per browser session, plus a single
         upgrade if the first send carried no email and one appears later. The
         email address is what the recovery campaign needs, so it is worth one
         extra row to capture it — and never more than that. */
      var SENT_KEY = 'ngfm_abandon_sent';   // '1' = sent, '2' = sent WITH an email
      var memState = '';                    // mirror, for private mode where sessionStorage throws

      function getState() {
        try { return sessionStorage.getItem(SENT_KEY) || memState; } catch (e) { return memState; }
      }
      function setState(v) {
        memState = v;                       // set first, so a throw below still dedupes in-page
        try { sessionStorage.setItem(SENT_KEY, v); } catch (e) {}
      }

      function trySend(useBeacon) {
        if (wasCompleted && wasCompleted()) return;
        var snap = getSnapshot();
        if (!snap) return;
        // Only count as "started" if at least email or phone is filled.
        if (!snap.email && !snap.phone) return;

        var state = getState();
        if (state === '2') return;                  // already captured, email and all
        if (state === '1' && !snap.email) return;   // already sent; nothing new to add

        setState(snap.email ? '2' : '1');
        send('started', snap, !!useBeacon);
      }

      // Eager (opt-in) capture: fire once an email/phone field is blurred, even
      // while still on the page. Off by default to keep the operator inbox to
      // genuine leave-without-buying events.
      if (opts && opts.onBlur) {
        document.addEventListener('blur', function (e) {
          if (!e.target || !e.target.matches) return;
          if (e.target.matches('input[type=email], input[type=tel], input[name=email], input[name=phone], #email, #phone')) {
            trySend(false);
          }
        }, true);
      }

      // Leave-flush on page hide — works on iOS Safari where 'beforeunload' is
      // unreliable. This is the primary (balanced) trigger.
      window.addEventListener('pagehide', function () { trySend(true); });
      window.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') trySend(true);
      });
    }
  };
})(window);
