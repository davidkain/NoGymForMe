# Tracking — one-time setup (≈5 minutes)

You'll do this once with **davidkain1@gmail.com**. After that, every popup signup, abandoned checkout, and completed order is automatically logged to a Google Sheet you own and emailed to you.

## 1. Create the Google Sheet

1. Open https://sheets.google.com → **Blank**.
2. Rename it to e.g. `NoGymForMe — Live Data`.
3. Look at the URL: `https://docs.google.com/spreadsheets/d/`**`<SHEET_ID>`**`/edit`. Copy the **SHEET_ID** part (the long random string).

The script will auto-create three tabs the first time data arrives:
- `Discount Signups`
- `Abandoned Checkouts`
- `Completed Orders`

## 2. Create the Apps Script

1. Open https://script.google.com → **New project**.
2. Delete the default `myFunction` code.
3. Open `apps-script.gs` from this repo, copy ALL its contents, paste into the script editor.
4. On line `const SHEET_ID = '';` — paste your SHEET_ID between the quotes.
5. Click the floppy-disk **Save** icon (or ⌘S). Name the project e.g. `NGFM Tracker`.

## 3. Deploy as a Web App

1. Top right → **Deploy** → **New deployment**.
2. Click the gear icon → **Web app**.
3. Settings:
   - **Description**: `NGFM tracker v1`
   - **Execute as**: **Me (davidkain1@gmail.com)**
   - **Who has access**: **Anyone** ← required so the website can POST without auth
4. Click **Deploy**.
5. The first time, Google will ask you to **authorize** — click through, pick davidkain1@gmail.com, click **Advanced** → **Go to NGFM Tracker (unsafe)** → **Allow**. (It's "unsafe" only because it's your own unverified script.)
6. Copy the **Web app URL** (looks like `https://script.google.com/macros/s/AKfy.../exec`).

## 4. Wire it into the website

1. Open `tracking.js` in this repo.
2. Paste the URL between the quotes on the line `URL: ''`.
3. Commit + deploy (the AI assistant can do this).

## 5. Verify

1. Open the live site, fill the discount popup with your email, submit.
2. Within ~10 seconds you should see:
   - A new row in the Google Sheet, highlighted yellow.
   - An email at davidkain1@gmail.com with the XLSX attached.
3. Repeat for the order page: fill name + email + phone, then close the tab → "Abandoned" email arrives.
4. Then go through a full order → "NEW ORDER" email arrives, and the abandoned row gets promoted to green "Completed".

## Troubleshooting

- **No email after 1 minute**: open the Apps Script editor → **Executions** (left side clock icon). Look for failed runs and read the error.
- **Permission errors on first email**: the very first run needs you to authorize Gmail send + Sheet edit. Re-run any function manually once from the editor (`Run` button) and accept the auth prompts.
- **Updating the script**: editing `apps-script.gs` here is just a copy. To update Google's version, paste the new contents back into the script editor and **Deploy** → **Manage deployments** → pencil icon on the existing deployment → **New version** → **Deploy**. (The URL stays the same.)

## What does NOT get sent

By design, the tracker can ONLY forward these fields:
- discount: `email`, `source`
- abandoned: `name`, `email`, `phone`, `plan`
- completed: `orderNum`, `name`, `email`, `phone`, `address`, `city`, `plan`, `total`

Card numbers, CVCs, and expiry dates are physically dropped at the boundary — even if a future code change accidentally tries to include them, the tracker silently strips them.
