# Store Screenshots

App Store + Google Play submission assets. Captured via Playwright at
`430×932` (iPhone 15 Pro Max CSS resolution) on `app.nogymforme.com`,
then upscaled to `1290×2796` via `sips` (exact 3.0× — matches the
retina DPR the device renders at).

## What's where

```
store-screenshots/
└── iphone-6.7/        ← 1290×2796 — required by Apple, also valid for Google
    ├── dashboard.png   ← landing screen post-login
    ├── weight.png      ← weight tracking
    ├── checkin.png     ← daily check-in (showed weight pre-fill + streak calendar)
    ├── meals.png       ← nutrition + meal plan
    ├── lounge.png      ← community feed with 3 categories
    └── profile.png     ← account + subscription
```

## Used for

**Apple App Store Connect** (`§5` of `../STORE_LAUNCH.md`):
- Required size: **6.7" Display = 1290×2796 px** ← these files match exactly
- Required count: minimum 3 — uploading all 6 gives variety

**Google Play Console** (`§5` of `../STORE_LAUNCH.md`):
- Required size: phone, minimum 1080×1920 (16:9)
- 1290×2796 has aspect ratio ~9:19.5 which is *taller* than Google's 9:16 minimum
  → these files automatically satisfy Google Play too
- Required count: minimum 2 — uploading all 6 gives variety

## How to regenerate

If the app UI changes substantially and these need to be re-captured:

```bash
# 1. Re-run the capture in Playwright at 430×932 viewport on the live app
# 2. Then upscale each:
cd store-screenshots/iphone-6.7
for src in *.png; do
  sips -z 2796 1290 "$src" --out "$src"
done
```

Or ask Claude to redo it via the same Playwright flow.

## Reviewer credentials (used to capture these)

Stored in the project's `STORE_LAUNCH.md` →
`appreview+stores@gmail.com` / `NgfmStores2026!`
(also routed via Gmail plus-addressing to `davidkain1@gmail.com`).
This same credential is what you supply to Apple's App Review and
Google Play's "App access" demo fields.
