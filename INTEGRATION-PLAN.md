# Live Data Integration Plan

*Updated 7 August 2026.*

Goal: every figure on the dashboard comes from a **direct first-party API pull** — no aggregators, no AI in the data path. Only two files are hand-maintained, because no API exists for them (targets, commission).

**Architecture:** one Vercel serverless function per source; credentials in env vars only; the browser calls nothing but our own `/api/*`; an unconfigured source returns `meta:{live:false, reason:"not-configured"}` so the panel shows an honest blank, never an error or a zero.

---

## 1. Live today

All **8 Shopify Plus stores** (iORA / TRT / SANS & SANS / MONOLOQ × SG + MY) are connected.

| Area | Endpoint | Source |
|---|---|---|
| Revenue, orders, AOV, units, sessions, conversion, discounts, new/returning customers | `/api/dashboard` | ShopifyQL + Orders API |
| Best sellers (SKU + title + images), category mix | `/api/insights` | ShopifyQL `product_type` (uncategorised shown as such, never guessed) |
| Discount codes + **configured terms**, monthly discounts → Promotion Calendar | `/api/insights` | ShopifyQL `GROUP BY discount_code TIMESERIES month` + Admin `read_discounts` |
| Traffic: referrers, order referrers, campaigns, monthly series, landing pages | `/api/insights` | ShopifyQL |
| Funnel (sessions → cart → checkout → purchase) | `/api/insights` | ShopifyQL sessions dataset |
| Voucher report (website) | `/api/insights` | discount pulls; `sent` / redemption-rate stay "—" until §3.1 |
| Pickup vs delivery, collection points, delivery districts | `/api/dashboard` | Orders — pickup from the `"Pick Up @ <store>"` shipping line; delivery aggregated to 2-digit postal districts |
| Sale vs full-price mix (revenue / units / SKUs) | `/api/dashboard` | Order line items + batched `compareAtPrice` lookup |
| Sales projection, brand ranking, SG-vs-MY | front end | derived from the above |
| **Ads tab — Meta** (spend, impressions, clicks, purchases, revenue, ROAS by month/week/campaign) | `/api/ads` | Meta Marketing API async insights jobs, `ads_read` on `act_317407367` (SG) and `act_406956756747490` (MY) |

**Auth (done since the last revision):** iORA SG uses a permanent Admin token (`TOKEN_IORASG`); the other seven mint a fresh ~24h token per cold start via the OAuth `client_credentials` grant (`api/_token.js`, `CLIENT_<STORE>`/`SECRET_<STORE>`). The 24-hour re-token chore is gone.

**Meta (live since 21 Aug 2026):** the app holds the **Marketing API Access Tier** (standard access) after App Review. Note the shape of the pull — Meta's *synchronous* insights endpoint is cut off at ~30s server-side, so a year of daily rows is only obtainable as an **async job** (`report_run_id`: submit → poll `async_status` → page the results). Do not “simplify” it back to a plain GET; it will work for a month and fail for a year. Full detail and measurements in ISSUES.md.

**Also since the last revision:** `/api/dashboard` has a *light* mode (KPIs without the orders paging) so brand switching stays fast; `scripts/probe-datasets.js` and `scripts/probe-columns.js` interrogate the live store for which ShopifyQL datasets/columns it will actually serve — that's what §4 is built from.

## 2. Built and tested — switched off pending access (no dev work left)

| Feature | Code | Waiting on |
|---|---|---|
| Ads tab — Google | `lib/ads-google.js` | Developer token at Basic access (**1–2 wks**) + OAuth refresh token for an MCC reader |
| Ads tab — TikTok | `lib/ads-tiktok.js` | App approval (days) + advertiser ids; confirm metric names against the live account |
| Channel Mix + marketplace vouchers | `/api/marketplace`, `lib/shopee.js`, `lib/lazada.js` | Shopee/Lazada partner + per-shop approvals (**weeks**) and `TOKEN_STORE_URL`/`_TOKEN` |

Exact variable names and lead-time steps are in `.env.example`. Two things that will bite if forgotten:

- **The Redis token store is not optional in production.** Shopee and Lazada invalidate the old refresh token on every refresh and Vercel env vars are read-only at runtime, so without it a redeploy strands the rotated pair (`reason:"auth"`).
- **Metric caveats are served, not silently averaged.** Google has no purchase metric — the figures are `conversions`/`conversions_value` (every counted action), so the Google table has no Purchases row. Meta takes the *first* matching purchase action type (summing double-counts). TikTok derives revenue from the first arithmetic its API version supports, or renders "—".

## 3. Not built yet

**3.1 Email (Dotdigital *or* Klaviyo) — blocked on a business decision.** Feeds the email block plus voucher `sent` counts and redemption rates. **Confirm the platform before building.** Then: API user + regional base URL → `api/email.js` for campaign send/delivered/open/click. Money stays Shopify-attributed; the ESP supplies engagement counts only. ~1–2 days. `DOTDIGITAL_API_USER` / `_PASSWORD` / `_BASE_URL`.

**3.2 Commission (eQuip / ECM) — no known public API.** The UI panels exist and are disabled. Ask IT whether eQuip exposes a reporting API or a scheduled export; build `api/commission.js` if so. Fallback: a validated hand-maintained `lib/commission.js` mirroring the targets pattern, labelled with its as-of date. ~0.5 day for the fallback.

**3.3 Sales targets — no API, needs the business.** `lib/targets.js` is **still an empty stub**; the chaser and targets panels stay hidden until it is filled from the consolidated ECM file. `npm test` validates the shape. 0.5 day once someone owns it. *This is the cheapest win on the list.*

**3.4 TikTok Shop** — no connector; not in Channel Mix.

**3.5 Access control** — the dashboard has **no login**; anyone with the URL sees Group sales. Worth a decision.

## 4. Buildable now with existing credentials (verified against the live store by the probe scripts)

| Addition | Effort | Note |
|---|---|---|
| **Returns / return rate** by month and product | S | Zero visibility today; direct margin cost — **do first** |
| **Stock sell-through**, days of cover, days out of stock | M | Completes the best-seller picture — do second |
| Sales by country/region | S | `billing_country` / `billing_region` — a real split (the fabricated one was removed) |
| Online vs retail: `pos_location_name`, `staff_member_name` | S | |
| Tax, shipping charged, extra sales measures | S | |
| Lapsed customers (time-since-last-order bands, aggregated) | M | |

**Investigate before promising:** profit margin / COGS (*highest value if cost data is maintained in Shopify — check this first*), on-site search terms, first/last-click attribution, delivery speed.
**Confirmed impossible — stop chasing:** sessions by visitor location/device, site-speed metrics. Shopify does not expose them; the template's figures there were placeholders.

## 5. Rules (enforced in code and E2E-tested)

1. Keys server-side only. Nothing in the HTML, ever.
2. Honest failure: failed ≠ zero; unattributable = `null` = "—"; `not-configured` → empty state. No estimates or illustrative data.
3. A pull that runs out of budget **fails its section** rather than serving partial pages — a half-paged month understates revenue, and a wrong number is worse than a missing one.
4. Caching: complete payloads edge-cached 5 min; transient failures `no-store`; deterministic per-section failures don't block caching.
5. Data handling: aggregated only. 2-digit postal districts are the only address-derived data served, and only for delivery orders.
6. Cancelled orders excluded everywhere, so order-derived sections tie to the ShopifyQL KPIs.

## 6. Known limitations

- Orders with >100 line items slightly undercount units; new-vs-returning is accurate for the current year only; automatic (non-code) discounts aren't attributable per code and render "—".
- Group roll-up uses a fixed `FX_MYR_SGD` — fine for comparison, not an accounting number.
- Long ranges can hit the 60s Hobby-plan ceiling on a cold load (a full-year orders pull measured ~89s from a home connection; `vercel.json` already sets `maxDuration` per function). Fix by upgrading the plan or narrowing the window.
- Marketplace revenue definitions won't reconcile to the cent with website revenue: Website = ShopifyQL gross sales, Shopee/Lazada = buyer-paid order value. The panel says so.
- UI debt: the discount panel's per-month drill-down exists but its entry point is hidden for live data (the old filter *rescaled* figures). Month detail is in the Promotion Calendar.

## 7. Verifying a credential set when it lands

1. `npm run preview-ads <brand>` / `npm run preview-marketplace <brand>` — real output, or a `not-configured` line naming the exact variables to set.
2. `npm test` — pure layers (roll-ups, signing, error mapping) need no keys.
3. `vercel dev` → open the Ads tab and Channel Mix. A platform that answered with no spend says so — different from one that isn't connected.
