# NOGYMFORME — App Store Launch Reference

Single source of truth for everything Apple App Store + Google Play submission.
Generated 4 June 2026 after PWABuilder packaging.

---

## TL;DR — what to do RIGHT NOW (today)

The Google Play 14-day closed-test clock is your critical path. Start it today
even with rough metadata; polish during the 14 days.

1. **Open Google Play Console** (~30 min) — https://play.google.com/console
   $25 one-time. Use your real legal name on the developer account; this is what
   appears as the publisher in store listings. Verify identity (Google sends a
   photo ID verification request).

2. **Open Apple Developer Program** (~30 min) — https://developer.apple.com/enroll
   $99/yr. Register as **Individual** (faster — instant approval) unless you
   need to register the company entity, in which case **Organization** requires
   a DUNS number (free but takes 5-30 days).

3. **Upload Android `.aab` to Play Console** as a closed test track
   → §6 of this doc. Add yourself + 19 testers (friends, family, customers).
   Day 1 of the 14-day clock starts when testers join.

4. **Open the iOS project in Xcode**, configure signing, archive
   → §7 of this doc. Aim to upload to App Store Connect within ~48 hours
   so the review queue is running while Google's clock ticks.

---

## Table of Contents

- [§1 — Critical-path timeline](#1-critical-path-timeline)
- [§2 — Apple Developer Program setup](#2-apple-developer-program-setup)
- [§3 — Google Play Console setup](#3-google-play-console-setup)
- [§4 — Store metadata — Hebrew + English](#4-store-metadata--hebrew--english)
- [§5 — Screenshots — sizes and capture strategy](#5-screenshots--sizes-and-capture-strategy)
- [§6 — Google Play upload + closed test](#6-google-play-upload--closed-test)
- [§7 — Xcode compilation + App Store Connect upload](#7-xcode-compilation--app-store-connect-upload)
- [§8 — Common rejection causes for supplement apps](#8-common-rejection-causes-for-supplement-apps)
- [§9 — After approval — launch checklist](#9-after-approval--launch-checklist)

---

## §1 — Critical-path timeline

```
DAY 0 — Today
├─ Open Google Play Console ($25)
├─ Open Apple Developer ($99/yr)
└─ Upload Android .aab → recruit testers → start 14-day clock

DAYS 1-3
├─ Submit iOS for review (Xcode → Transporter)
├─ Polish Hebrew + English store metadata (use §4 of this doc)
├─ Capture proper store screenshots (use §5 of this doc)
└─ Apple review begins (~24-72h queue)

DAYS 3-5
├─ iOS APPROVED → LIVE in App Store ✓
└─ Promote iOS via website (App Store badge + universal link)

DAYS 5-14
├─ Iterate on Android closed-test feedback
├─ Add features customers actually ask for
└─ Update Hebrew + English copy based on early App Store reviews

DAYS 14-17
├─ Google 14-day clock expires
├─ Promote Android closed test → production
└─ Android LIVE in Google Play ✓
```

---

## §2 — Apple Developer Program setup

### Account creation (30 min, then 24-48h email confirmation)

1. Go to **https://developer.apple.com/enroll** while signed into your Apple ID.
2. Choose **Individual**.
3. Enter your legal full name + Israeli address.
4. Pay $99 USD. Apple charges immediately.
5. Confirmation email arrives in 24-48h.

### After enrollment — App Store Connect setup (1 hour)

6. Open **https://appstoreconnect.apple.com**.
7. **My Apps → +→ New App**
   - **Platforms:** iOS
   - **Name:** `NoGymForMe`
   - **Primary Language:** Hebrew (he)
   - **Bundle ID:** `com.nogymforme.app` (must match what you set in Xcode in §7)
   - **SKU:** `nogymforme-ios-001` (internal; visible only to you)
   - **User Access:** Full Access
8. **App Information** (left nav)
   - **Subtitle (he):** מעקב יומי לגברים
   - **Category:** Primary = **Health & Fitness** · Secondary = **Lifestyle**
   - **Content Rights:** "Does your app contain, show, or access third-party content?" → No
   - **Age Rating:** Run the questionnaire. Answer:
     - Unrestricted Web Access: No
     - Medical/Treatment Info: **Infrequent/Mild** (you discuss weight management)
     - Everything else: None
     - Result: 12+
9. **Pricing and Availability** → Free, available in Israel + worldwide.
10. **App Privacy** → Required. Use the privacy policy you already have at
    **https://nogymforme.com/privacy.html**. Run through Apple's questionnaire:
    - **Email addresses:** Collected, linked to user identity, used for App Functionality + Analytics. Not used for tracking.
    - **Name:** Same.
    - **Phone Number:** Same.
    - **Physical Address:** Collected at checkout, used for Product Personalization (shipping). Not for tracking.
    - **Crash Data:** Collected (via Vercel), used for App Functionality. Not for tracking.
    - **Product Interaction:** Collected via analytics (GTM, Pixel). Used for Analytics. **YES for tracking** — flag this honestly.
    - **Advertising Data:** Facebook Pixel collects this. Used for Third-Party Advertising. **YES for tracking.**

### Common Israeli-account gotchas

- **Apple charges in USD** but your statement may show ILS conversion. Budget ~₪370/yr.
- **App Store Connect interface is English-only**; the *app metadata you publish* can be Hebrew, but Apple's back-office is English.
- **Bank account for payouts** must be linked separately under **Agreements, Tax, and Banking**. Skip if app is free.

---

## §3 — Google Play Console setup

### Account creation (30 min + identity verification 24-72h)

1. Go to **https://play.google.com/console**.
2. Sign in with the Google account you want to publish under (consider creating
   `play+nogymforme@gmail.com` for separation — better than personal account).
3. Choose **Individual** (faster) or **Organization** (requires D-U-N-S equivalent).
4. Pay $25 USD one-time.
5. **Verify identity:** Google sends an email asking for:
   - Government ID photo (Israeli תעודת זהות or passport)
   - Selfie
   Verification takes 24-72h.

### After verification — create the app entry (30 min)

6. **Create app** button. Enter:
   - **App name:** `NoGymForMe`
   - **Default language:** Hebrew (he-IL)
   - **App or game:** App
   - **Free or paid:** Free
   - **Declarations:** check both ("I confirm the app meets Play Store guidelines" + "I confirm I'm not a US-sanctioned country")
7. **Set up your app** dashboard — Google guides you through 7-10 sub-tasks.
   I'll cover the meaningful ones in §6.

### Common Israeli-account gotchas

- **Payment for $25 fee:** must be a credit card with billing address matching your developer-account address. Use the same address as your Apple Developer account.
- **Identity verification:** photo your ID against a plain background. If rejected, retake in better lighting.
- **The 20-tester rule is firm.** Google does not waive it. Start recruiting *now*.

---

## §4 — Store metadata — Hebrew + English

Copy-paste ready. Use Hebrew for he-IL locale, English for en-US fallback.

### App Name (both stores, both languages)

- **Hebrew (he-IL primary):** `NoGymForMe`
- **English (en-US):** `NoGymForMe`

*Same in both — brand consistency. Don't translate.*

### Subtitle / Short description (30 chars)

- **Hebrew:** `פחות חדר כושר. יותר תוצאות.`
- **English:** `Less gym. More results.`

### Promotional text (170 chars, Apple) / Short description (80 chars, Google)

- **Hebrew (Apple promo, 170c):**
  > הצטרף לאלפי הגברים מעל גיל 35 שגילו דרך חדשה לרדת במשקל — בלי דיאטות קיצוניות, בלי לבזבז שעות בחדר כושר.

- **Hebrew (Google short, 80c):**
  > מעקב יומי, מטרות ברורות, תוצאות אמיתיות. לגברים שלא הולכים לחדר כושר.

- **English (Apple promo, 170c):**
  > Join thousands of men over 35 who found a new way to lose weight — without extreme diets and without wasting hours at the gym.

- **English (Google short, 80c):**
  > Daily tracking, clear goals, real results. For men who don't go to the gym.

### Full description (Apple 4000c / Google 4000c)

**Hebrew (paste exactly):**

```
NoGymForMe היא האפליקציה הרשמית של מותג תוסף התזונה NOGYMFORME — הפתרון הטבעי הראשון בישראל המיועד ספציפית לגברים מעל גיל 35.

אם אתה גבר שמתמודד עם:
• האטה בחילוף החומרים אחרי גיל 35
• כרס שלא הולכת למרות דיאטות
• חוסר זמן או רצון ללכת לחדר כושר
• עייפות וחוסר אנרגיה

האפליקציה הזו בשבילך.

מה אתה מקבל באפליקציה:
✓ מעקב יומי אחר התקדמות, משקל, ואנרגיה
✓ צ׳ק-אין יומי שלוקח פחות מ-30 שניות
✓ תפריט תזונה מותאם אישית
✓ קהילת הגברים שלנו — שאלות, התקדמות, תמיכה
✓ מדריכים מקצועיים, סרטוני וידאו ותכנים בלעדיים
✓ ניהול המנוי שלך — דחיית משלוח, ביטול, החלפת כתובת
✓ מערכת תגמולים שמתגמלת אותך על עקביות

NoGymForMe מתאים לגברים שמתמלאים מהבטחות הוליסטיות־ניו־אייג׳יות ורוצים פתרון פרקטי, ישיר, ובדוק שעובד גם בלי לעבור מהפכת חיים.

האפליקציה זמינה אך ורק ללקוחות שרכשו את תוסף ה-NOGYMFORME. רכישה מתבצעת באתר nogymforme.com.

⚠️ הצהרה: NOGYMFORME הוא תוסף תזונה, לא תרופה. תוצאות משתנות. התייעץ עם רופא לפני שימוש.

לשאלות ותמיכה: davidkain1@gmail.com · וואטסאפ +972-55-919-0077
מדיניות פרטיות: nogymforme.com/privacy.html
תנאי שימוש: nogymforme.com/terms.html
```

**English (paste exactly):**

```
NoGymForMe is the official app of the NOGYMFORME supplement brand — the first natural solution in Israel specifically designed for men over 35.

If you're a man dealing with:
• Slowing metabolism after age 35
• Stubborn belly fat that won't budge despite diets
• No time or motivation for the gym
• Constant fatigue and low energy

This app is for you.

What you get inside:
✓ Daily progress, weight, and energy tracking
✓ 30-second daily check-in
✓ Personalized nutrition plan
✓ Our men's community — questions, progress, support
✓ Professional guides, videos, and exclusive content
✓ Subscription management — delay shipments, cancel, update address
✓ Rewards program that recognizes consistency

NoGymForMe is for men tired of holistic-new-age promises who want a practical, direct, tested solution that works without overhauling their entire life.

This app is available exclusively to customers who have purchased the NOGYMFORME supplement. Purchases are made at nogymforme.com.

⚠️ Disclaimer: NOGYMFORME is a dietary supplement, not a medication. Results vary. Consult a doctor before use.

Support: davidkain1@gmail.com · WhatsApp +972-55-919-0077
Privacy: nogymforme.com/privacy.html
Terms: nogymforme.com/terms.html
```

### Keywords (Apple only — 100 chars total, comma-separated)

**Hebrew:**
```
תוסף,ירידה במשקל,גברים,חדר כושר,כושר,בריאות,דיאטה,אנרגיה,חילוף חומרים,כרס
```

**English (use this as Apple's "English keywords"):**
```
supplement,weight loss,men,gym,fitness,health,diet,energy,metabolism,belly fat
```

### What's new (release notes, both stores)

**Hebrew (version 1.0.0):**
```
🚀 השקה ראשונה של NoGymForMe!
✓ מעקב יומי אחר משקל ואנרגיה
✓ קהילת הגברים שלנו
✓ מדריכים בלעדיים ותפריטים מותאמים
✓ ניהול מנוי מלא מתוך האפליקציה
```

**English (version 1.0.0):**
```
🚀 Launch of NoGymForMe!
✓ Daily weight + energy tracking
✓ Men's community
✓ Exclusive guides and personalized plans
✓ Full subscription management in-app
```

### Category (both stores)

- **Primary:** Health & Fitness
- **Secondary (Apple only):** Lifestyle

### Age rating

- **Apple:** 12+ (questionnaire result: weight management = "Mild medical info")
- **Google:** Teen (IARC questionnaire — answer "no" to violence, sexual content, gambling, controlled substances; "yes" to "user-generated content" if you have the lounge feature; result will be Teen)

---

## §5 — Screenshots — sizes and capture strategy

**Critical:** these are DIFFERENT from the screenshots in `manifest.json`.
Store screenshots have strict size requirements and must show *actual app content*.

### Apple App Store requirements

| Device | Size | Required? | How many |
|---|---|---|---|
| iPhone 6.7" (Pro Max class) | 1290 × 2796 | **Yes** | 3-10 |
| iPhone 6.5" (older Pro Max) | 1242 × 2688 | Optional | up to 10 |
| iPhone 5.5" (Plus class) | 1242 × 2208 | Optional | up to 10 |
| iPad Pro 12.9" (6th gen) | 2048 × 2732 | Required if shipping for iPad | 3-10 |

**Minimum:** 3 iPhone 6.7" screenshots.

### Google Play requirements

| Device | Size | Required? | How many |
|---|---|---|---|
| Phone | 1080 × 1920 minimum | **Yes** | 2-8 |
| 7" tablet | 1200 × 1920 minimum | Optional | 0-8 |
| 10" tablet | 1600 × 2560 minimum | Optional | 0-8 |
| Feature graphic | 1024 × 500 | **Required** | 1 |

**Minimum:** 2 phone screenshots + 1 feature graphic.

### Capture strategy

**Option A — Use a real phone (fastest, recommended):**
1. Log into `app.nogymforme.com` on your iPhone (15 Pro Max recommended — its 6.7" resolution matches Apple's required size).
2. Navigate to each screen, take a screenshot (Side + Volume Up).
3. Screens to capture:
   - Login page
   - Dashboard
   - Weight tracking
   - Meals / nutrition
   - Lounge community
   - Profile / subscription
4. Email yourself or AirDrop the screenshots.
5. iOS screenshot is automatically 1290×2796 — no resizing needed.

**Option B — Use a desktop browser at exact dimensions (works but tedious):**
1. Chrome DevTools → Toggle device toolbar → Custom size 1290×2796 (3x DPR).
2. Navigate to each authed screen.
3. DevTools → ⋮ → Capture full-size screenshot.

**Option C — Ask me to capture them via Playwright** if you give me a test
account (or a session token / cookie). I can grab all device sizes in a batch.

### Feature graphic (Google Play, 1024×500)

This is the banner at the top of your Google Play listing. Create one of:
- Hire someone on Fiverr ($15-50, 24h turnaround)
- Use Canva (free, ~20 min) — search "Google Play feature graphic" templates
- Have me mock one up using brand colors (gold NGFM on dark with tagline)

---

## §6 — Google Play upload + closed test

### After your `.aab` is in hand

1. **Play Console → All apps → NoGymForMe → Production** (left nav).
2. *Don't actually publish to Production yet.* First, set up a **Closed testing** track:
   **Testing → Closed testing → Create track → Name: "Internal alpha"**
3. **Create release** → upload your `.aab` file.
4. Add **Release notes** in Hebrew + English (use §4's "What's new" copy).
5. **Review release** → fix any errors Play Console flags (usually missing
   privacy policy URL — add `https://nogymforme.com/privacy.html`).
6. **Start rollout to Closed testing.**

### Recruit the 20 testers

1. **Testers tab → Create email list** → Add 20 email addresses.
   - Use the 20 most likely-to-engage customers from your Completed Orders sheet
   - Or friends/family who will install + open the app a few times
2. Email the testers the **opt-in link** Play Console gives you (looks like
   `https://play.google.com/apps/internaltest?...`).
3. They must click → "Become a tester" → then they can download from Play Store.
4. **Day 1 of the 14-day clock = the day at least 20 testers have opted in.**

### Pre-launch report

Within 24h of upload, Google runs your app on real devices and produces a
"Pre-launch report" (left nav). Check it. Common issues:
- **Crashes on launch:** usually missing env vars or Prisma migrations
- **Permission requests:** Google flags any permission you ask for that the
  manifest doesn't justify
- **Performance:** anything below 30fps gets flagged

Fix anything critical, re-upload, repeat.

### Production rollout (after 14 days)

After 14 days with at least 20 active testers, **Production track → Create
release → Promote release from Closed testing**. Google reviews (~3-7 days
now that they know you). App goes live.

---

## §7 — Xcode compilation + App Store Connect upload

You picked DIY Xcode. Here's the full flow.

### One-time Xcode setup (~1 hour)

1. **Install Xcode 16+** from Mac App Store (free, 8GB download).
2. Open Xcode → **Settings → Accounts → +** → Sign in with your Apple Developer
   Apple ID. Xcode auto-fetches your team certificates.
3. **Settings → Locations → Command Line Tools** → select latest Xcode.
4. Install **Transporter** (free, separate app from Mac App Store).
   This is what uploads your `.ipa` to App Store Connect.

### Per-build: open PWABuilder's Xcode project

1. Unzip the iOS package from PWABuilder.
2. Open the `.xcworkspace` file (NOT the `.xcodeproj`) — workspace handles
   dependencies correctly.
3. In Xcode top bar: **Product → Destination → Any iOS Device (arm64)**
   (not a simulator — must be a real device target for archive).

### Configure signing

4. **Top-left project navigator → click project name → Signing & Capabilities**
5. **Team:** select your Apple Developer team (your name).
6. **Bundle Identifier:** verify it's `com.nogymforme.app` (must match
   App Store Connect from §2.7).
7. **Automatically manage signing:** ✓ checked. Xcode generates provisioning
   profile + cert automatically.
8. Wait for **"Provisioning Profile: Created"** to appear (10-30 seconds).
   If you see "Failed to register bundle identifier", go to
   https://developer.apple.com/account/resources/identifiers/list,
   manually add the bundle ID, then back to Xcode.

### Set version + build number

9. **General tab → Identity:**
   - **Version:** `1.0.0`
   - **Build:** `1` (increment by 1 for every upload to App Store Connect, even
     for the same version)

### Archive + upload

10. **Product → Archive** (takes ~2-5 minutes the first time).
11. Xcode auto-opens the **Organizer** window after archive completes.
12. Select your archive → **Distribute App → App Store Connect → Upload**.
13. Follow prompts — Xcode handles signing the upload, then uploads via
    its own pipeline (you don't need Transporter for Xcode-direct uploads).
14. Wait for **"Successfully uploaded"** dialog.
15. Within ~5-15 minutes, your build appears in App Store Connect under
    **TestFlight → Builds**. While there, Apple runs automatic processing
    (~10-30 min) for export compliance and crash symbolication.

### Finalize App Store listing + submit

16. Back in **App Store Connect → My Apps → NoGymForMe → 1.0 Prepare for Submission**:
    - Paste all the §4 metadata
    - Upload screenshots from §5
    - **Build:** click "+" → select the build you just uploaded
    - **App Review Information** → support phone, email, demo credentials
      (give them a real test account so they can actually log in)
17. **Submit for Review** (top right).
18. Apple's review queue is currently ~24-72h.

### Common Xcode errors + fixes

- **"No account for team"** → re-sign in under Settings → Accounts.
- **"Code signing failed"** → uncheck and re-check "Automatically manage signing".
- **"Bundle identifier in use"** → ensure your Apple Developer account is the
  owner of `com.nogymforme.app`. If you registered it elsewhere, transfer.
- **"Export Compliance"** → answer No to "Uses non-exempt encryption" (HTTPS
  doesn't count; you're using standard system encryption).

---

## §8 — Common rejection causes for supplement apps

Apple is particularly strict about health/wellness. Pre-empt these:

| Cause | How to avoid |
|---|---|
| Medical claims | Don't say "cures" or "treats". Use "supports", "may help". Already aligned in §4 copy. |
| Marketing-only app | Apple rejects apps that are just a brochure for the brand. Your app has real functionality (tracking, community, guides) — this is fine. Just make sure the first screen post-login isn't "Buy now". |
| Missing privacy policy URL | Already have `nogymforme.com/privacy.html`. Paste exact URL. |
| Inaccurate App Privacy answers | Apple cross-checks with your network behavior. Be honest about Facebook Pixel + Google Analytics tracking. |
| Login wall on first launch with no demo account | Provide demo credentials in App Review Information OR show a meaningful onboarding before login. |
| Screenshots that don't match the app | Don't use marketing renders — only real screen captures. |
| In-app purchase not using Apple's billing | If you sell anything inside the app, you must use StoreKit. Since your purchases happen at nogymforme.com (web), you're exempt — explicitly mention this in App Review notes. |

Google Play is more lenient but cares about:

| Cause | How to avoid |
|---|---|
| Missing privacy policy URL | Same as Apple. |
| Permissions not declared in manifest | Use only what you actually need. Currently your app needs minimal permissions. |
| Sensitive data without justification | If you collect health data (weight), declare in Data Safety section that it's used for app functionality only. |
| Misleading category | Health & Fitness is correct. Don't pick Medical (requires HIPAA-equivalent certifications you don't have). |

---

## §9 — After approval — launch checklist

### Day of iOS approval
- [ ] Update `index.html` App Store button: replace `href="#"` with `https://apps.apple.com/app/idXXXXXXXXX` (Apple gives you this ID).
- [ ] Add Apple Smart App Banner meta to all marketing pages:
      `<meta name="apple-itunes-app" content="app-id=XXXXXXXXX">`
- [ ] Test the "Open in App" flow from iPhone Safari.

### Day of Google Play public release
- [ ] Update `index.html` Google Play button: replace `href="#"` with `https://play.google.com/store/apps/details?id=com.nogymforme.app`.
- [ ] Add `assetlinks.json` to `nogymforme.com/.well-known/assetlinks.json` for Android App Links (so taps on `nogymforme.com/...` open the app instead of browser).

### Marketing
- [ ] Email existing customers: "The app is live"
- [ ] Update Instagram/Facebook bio with store links
- [ ] Add to email signature

### Monitoring
- [ ] App Store Connect → Analytics — daily check first week
- [ ] Google Play Console → Statistics — daily check first week
- [ ] Set up crash alerting (Sentry is good for both)

---

## File reference

- Privacy policy: `/privacy.html` (already live)
- Terms of service: `/terms.html` (already live)
- App icon master: `/app-icon.svg` (already live)
- PWA manifest: `https://app.nogymforme.com/manifest.json` (already live)
- Service worker: `https://app.nogymforme.com/sw.js` (already live)

---

*Document version 1.0 — 4 June 2026. Update as you hit each step.*
