# VIP Subscription — Early-Cancellation Settle-Up Spec (Summit / UPAY)

> Billing system of record: **Summit** (SUMIT/OfficeGuy API). Underlying clearing
> gateway: **UPAY** — beneath Summit; we never call it directly. All charges,
> refunds, recurring billing, and webhooks go through Summit's API.

Implementation spec for the "90-day journey price" model on the NOGYMFORME VIP subscription.
The customer can cancel at **any** time (no legal lock-in). The discounted price is *contingent*
on completing the 90-day journey; cancel early and the already-shipped bottles are re-priced to the
regular one-time price, and the difference is charged. This is a **price recalculation, not a penalty.**

> This document is the source of truth for the backend cancellation handler. The customer-facing copy
> in `index.html` (VIP box, cancellation FAQ, "איך עובד מחיר המסע?" FAQ) is written to match this logic
> exactly. **If you change this logic, update that copy too**, or the page becomes a misrepresentation.

---

## 1. Constants

| Name | Value | Notes |
|---|---|---|
| `VIP_MONTHLY` | ₪155 | Discounted monthly price (one bottle/month) |
| `REGULAR_BOTTLE` | ₪198 | Regular one-time per-bottle price (the "All-In" per-bottle price) |
| `MONTHLY_DIFF` | ₪43 | `REGULAR_BOTTLE − VIP_MONTHLY`. **Compute, do not hardcode** — see Edge Case E9 |
| `JOURNEY_CYCLES` | 3 | Cycles required to "complete" the journey (= 90 days) |
| `GUARANTEE_DAYS` | 14 | Money-back-guarantee window (day 14 **inclusive**) |
| `SHIPPING_FALLBACK_DAYS` | 5 | If delivery date is unknown, assume delivery = first charge + 5d (→ guarantee window effectively ends at charge + 19d) |

`clawback = bottles_shipped × MONTHLY_DIFF`

---

## 2. State to track per VIP subscriber

Without this data the handler cannot compute correctly. Persist:

- `subscription_id`, `customer_id`
- `summit_customer_id` + `summit_payment_id` — Summit customer + saved payment-method references (captured at signup) used to charge the settle-up
- `first_delivery_date` — **drives the 14-day window** (date the customer received bottle #1, from the HFD/Cheetah courier webhook/data). **Fallback:** if missing, use `first_charge_date + SHIPPING_FALLBACK_DAYS` (see E2)
- `first_charge_date` — date the first ₪155 charge cleared (anchor fallback + audit)
- `customer_dedup_key` — normalized email + phone + national ID, for the one-guarantee-per-customer rule (E11)
- `consent_timestamp` — when the customer agreed to the settle-up terms at checkout (chargeback defense)
- `cycles[]` — one record per monthly cycle: `{ cycle_n, charge_date, charge_status, bottle_shipped: bool, amount }`
- `subscription_status` — `active | canceled | completed_journey`
- `cancellation_txn_id` — for idempotency (see E12)

**Definitions (use these exactly):**
- `bottles_shipped` = count of cycles where `charge_status = success` **AND** `bottle_shipped = true`.
  Do **not** count scheduled-but-unshipped or failed-charge months.
- `completed_cycles` = same count (one bottle per successful cycle).
- `total_charged` = sum of `amount` across successful cycles.

---

## 3. Cancellation decision tree (PRECEDENCE IS STRICT — evaluate top to bottom, stop at first match)

```
on VIP cancellation request:

  ── STEP 0: resolve the guarantee anchor (delivery date, with fallback) ──
  guarantee_anchor = first_delivery_date
                     ?? (first_charge_date + SHIPPING_FALLBACK_DAYS)   # 5d fallback
  guarantee_deadline = guarantee_anchor + GUARANTEE_DAYS                # +14d, inclusive

  ── STEP 1: 14-DAY MONEY-BACK GUARANTEE (highest precedence) ──
  IF today <= guarantee_deadline:                                       # day 14 inclusive
      AND guarantee_not_already_used_by_customer(customer_dedup_key):   # one per customer (E11)
      refund_amount  = total_charged          # give everything back
      clawback       = 0                       # NEVER charge a difference inside the window
      status         = canceled
      mark_guarantee_used(customer_dedup_key)
      → issue FULL REFUND, stop subscription
      RETURN   # do NOT evaluate Step 2/3

  # NOTE: if the customer already used their lifetime guarantee on a prior
  # subscription (E11), they fall through to Step 2 even inside 14 days.

  ── STEP 2: EARLY CANCEL, MID-JOURNEY (day 15 .. before 3rd cycle done) ──
  ELSE IF completed_cycles < JOURNEY_CYCLES:
      clawback       = bottles_shipped * MONTHLY_DIFF
      refund_amount  = 0
      status         = canceled
      → CHARGE clawback to payment_token, stop subscription
      RETURN

  ── STEP 3: JOURNEY COMPLETE (3+ cycles) ──
  ELSE:   # completed_cycles >= JOURNEY_CYCLES
      clawback       = 0                       # discount is EARNED, permanent
      refund_amount  = 0
      status         = completed_journey (or canceled if they also stop)
      → clean cancellation, ₪0
      RETURN
```

**The precedence rule in one sentence:** the 14-day guarantee always wins. If the cancel date is
within 14 days of first delivery, it is a full refund with zero clawback — *even though*
`completed_cycles` is 0 or 1 and Step 2 would otherwise apply.

---

## 4. Worked examples

| When they cancel | bottles_shipped | Branch | Customer outcome |
|---|---|---|---|
| Day 5 (got 1 bottle) | 1 | **Step 1** | **Full refund ₪155**, clawback ₪0 |
| Day 14 exactly (got 1) | 1 | **Step 1** | Full refund (boundary inclusive — see E2) |
| Day 20 (got 1 bottle, 1 cycle) | 1 | Step 2 | Charge **₪43** (1 × 43) |
| Day 75 (got 2 bottles, 2 cycles) | 2 | Step 2 | Charge **₪86** (2 × 43) |
| Day 95 (got 3 bottles, 3 cycles) | 3 | Step 3 | **₪0**, discount kept for life |

These match the FAQ examples in `index.html` (the ₪86-after-2-months case is shown verbatim on the page).

---

## 5. Edge cases (each needs an explicit decision before launch)

**E1 — Guarantee + early-cancel overlap.** Always resolved by precedence: Step 1 wins. Full refund, no clawback. (No code branch needed beyond the ordered tree.)

**E2 — Boundary days (14 and 90). ✅ DECIDED.**
- Guarantee = `today <= guarantee_deadline` **inclusive** — day 14 still refunds.
- Guarantee anchor = **actual delivery date** (HFD/Cheetah). If the delivery date is missing for any reason, fall back to **first charge + 5 days** (so the window ends at charge + 19 days — generous to the customer by design).
- Journey complete = **the moment the 3rd recurring monthly charge successfully clears** (`completed_cycles >= 3`). A cancel during cycle 3 before the 3rd charge clears = Step 2 with `bottles_shipped = 2`.

**E3 — What counts as a "completed cycle."** Only `charge_status = success AND bottle_shipped = true`. A scheduled future month is never counted. This protects the customer (no clawback for product never received) and you (no clawback you can't justify).

**E4 — Failed monthly charge / dunning.** If a monthly charge fails: do not ship, do not count the cycle. Retry policy (recommend 3 retries over 7 days). If unrecovered, treat as cancellation at the **last successful cycle** and run the tree (clawback on bottles actually received). Never clawback for an unpaid bottle.

**E5 — Refund requested *after* a settle-up was charged.** Recommended policy: the settle-up is **final** — it is merely the regular price for product already delivered and used. (Inside 14 days this never arises, because Step 1 would have refunded everything.) State this in checkout T&C.

**E6 — Returned product.** Opened supplements are non-returnable by law, clawback still applies to shipped bottles. If a bottle shipped but is returned **unopened and within the consumer-law window**, exclude it from `bottles_shipped`.

**E7 — Chargeback defense.** Because you charge the card **after** cancellation, you must be able to prove consent. Store `consent_timestamp`, show the settle-up terms at checkout (not only in the FAQ), and email an itemized settle-up receipt (see §6). Keep the FAQ/T&C wording and the charge math identical.

**E8 — Saved-method validity.** The settle-up depends on a valid stored Summit payment method. If the charge is declined (expired card etc.): do not silently fail. Fall back to a Summit payment link / emailed invoice for the difference, and mark `clawback_status = pending`. (In safe mode this is the default path — the operator is emailed to collect manually.)

**E9 — Price changes / promos.** `MONTHLY_DIFF` must be computed from the **prices that applied to that subscriber's cycles**, not a global ₪43 constant. If a subscriber joined on a different promo price, store the per-cycle `regular_equivalent` and `paid` and compute `diff = Σ(regular_equivalent − paid)`. Hardcoding 43 breaks the moment you run any pricing test.

**E10 — No proration.** Billing is whole-bottle monthly. Cancellation stops future shipments; there is no partial-month refund and no partial-bottle clawback. Clawback is per whole bottle shipped.

**E11 — Cancel then resubscribe. ✅ DECIDED: one guarantee per customer, for life.** The 14-day money-back guarantee is granted **once per customer**, deduplicated by a normalized key of **email + phone + national ID** (`customer_dedup_key`). A returning subscriber starts a fresh 90-day journey but does **not** get a second money-back guarantee — so an early cancel on a re-subscription runs Step 2 (settle-up), even within 14 days. This kills guarantee-cycling. Persist a `guarantee_used` ledger keyed by `customer_dedup_key`; check it in Step 1.

**E12 — Idempotency.** The cancellation handler MUST be idempotent. A double-click, retry, or webhook redelivery must not double-charge the settle-up. Guard with `cancellation_txn_id` (generate once, reject duplicates).

**E13 — Currency/rounding.** All amounts are integer NIS (43, 86, 129…). No rounding logic needed unless promo pricing introduces fractions (E9) — if so, round to agora and document.

---

## 6. Settle-up charge & receipt (Summit)

1. Compute `clawback` per the tree.
2. If `clawback > 0`: charge `clawback` to `payment_token` as a **one-time** transaction with a clear descriptor (e.g. `NOGYMFORME - השלמת מחיר`).
3. Log: `{ cancellation_date, bottles_shipped, completed_cycles, guarantee_applied, refund_amount, clawback_amount, summit_txn_id }`.
4. Email the customer an **itemized** confirmation:
   - bottles received, price paid (₪155 each), recalculated price (₪198 each), difference charged.
   - This is both a courtesy and the primary chargeback defense.
5. Set `subscription_status` and stop future recurring charges/shipments.

---

## 7. Implementation checklist

- [ ] Store `first_delivery_date`, `payment_token`, `consent_timestamp`, `cycles[]` per subscriber
- [ ] Show settle-up terms at **checkout** (consent), not only in the FAQ
- [ ] Implement the ordered decision tree (§3) — guarantee precedence first
- [ ] Compute `MONTHLY_DIFF` from stored per-cycle prices (E9), not a constant
- [ ] Summit one-time charge (`/billing/payments/charge/`) against saved method + declined-card fallback (E8)
- [ ] Idempotency guard (E12)
- [ ] Dunning policy for failed monthly charges (E4)
- [ ] Itemized settle-up email (§6.4)
- [ ] Decide E11 (resubscribe guarantee) and E5 (post-settle-up refund) and document
- [ ] Keep this spec and the `index.html` copy in sync on any change

---

## 8. Resolved decisions (locked 2026-06-27)

1. **E2 boundaries — ✅** Day 14 **inclusive**. "Journey complete" = the moment the **3rd recurring monthly charge successfully clears**.
2. **E11 resubscribe — ✅** Money-back guarantee is **one per customer for life**, deduplicated by **email + phone + national ID**. No second guarantee on re-subscription.
3. **14-day anchor — ✅** Count from **actual delivery date** (HFD/Cheetah tracking). If delivery data is missing, **fall back to first charge + 5 days** (window ends charge + 19d).
4. **Where it's built — ✅** In **`apps-script.gs`**, alongside the existing serverless logic, Summit integration (UPAY gateway underneath), and webhooks.

## 9. ⚠️ Integration gap found in the current `apps-script.gs` (must close before this can run)

The base `apps-script.gs` was a **tracking + Sheets + email** script with no payment
integration. The VIP handler now adds the missing model in that same file:
- `VIP Subscriptions` + `VIP Cancellations` tabs (the §2 state + audit/idempotency ledger)
- dispatch types `vipSubscribe`, `vipCycle`, `vipCancel`, `summitWebhook`
- `computeVipCancellation_()` (pure decision tree) and `chargeSettleUpViaSummit_()` (isolated charge)

**What still must be wired to go end-to-end (outside this file):**
1. **At VIP signup**, call `vipSubscribe` with the **Summit customer id + payment-method id** (and `firstChargeDate`). This is the front-of-house capture — Summit returns these when the recurring order is created.
2. **Summit recurring-payment webhook → `summitWebhook`** (or call `vipCycle` directly) on each cleared monthly charge, passing the Summit payment ref as `chargeRef` (dedupes redelivery) and `deliveryDate` from the HFD/Cheetah feed when available.
3. **Set Script Properties** `SUMIT_COMPANY_ID` + `SUMIT_API_KEY` to leave safe mode.

The **actual charge** is isolated in `chargeSettleUpViaSummit_()` → `POST https://api.sumit.co.il/billing/payments/charge/`. Until the Script Properties above are set (or the Summit ids are missing on a subscription), the handler runs in **safe mode**: it records the exact owed/refund amount and emails the operator to act manually — it never fakes or guesses a charge. UPAY (Summit's clearing gateway) is never contacted directly.
