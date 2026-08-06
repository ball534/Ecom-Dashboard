# Live Data Integration Plan

Goal: light up every empty panel in the dashboard with **direct first-party API connections only** — no third-party aggregators or AI services in the data path. Every figure on the dashboard must be derived from an API pull; nothing hand-typed except the two internal files that have no API source (targets, commission).

Architecture (in place and proven): one Vercel serverless function per source, credentials in environment variables (`.env` locally, Vercel project env in production), the browser only ever calls our own `/api/*` endpoints, and an unconfigured source returns `meta:{live:false, reason:"not-configured"}` so the UI shows an honest blank instead of an error.

---

## Current state — after Phase 0 (built, verified end-to-end against the live SG store)

| Dashboard area | Status | Source |
|---|---|---|
| Revenue, orders, AOV, units, sessions, conversion, discounts, customers | ✅ Live | Shopify (ShopifyQL + Orders API) via `/api/dashboard` |
| Best sellers, category mix, discount codes, traffic attribution | ✅ Live | Shopify via `/api/insights` |
| **Funnel (sessions → cart → checkout → purchase)** | ✅ Live | ShopifyQL sessions dataset (`sessions_with_cart_additions`, `sessions_that_reached_checkout`, `sessions_that_completed_checkout`) |
| **Pick-up vs Delivery + collection points + delivery districts** | ✅ Live | Orders pull — pickup detected from the `"Pick Up @ <store>"` shipping-line title; delivery areas aggregated to 2-digit postal districts server-side (pickup orders' home zips excluded) |
| **Sale vs full-price mix (revenue, units, SKUs)** | ✅ Live | Orders line items + batched GraphQL `compareAtPrice` lookup — a line is "sale" when it sold below its variant's current compare-at price |
| **Per-month discount performance → Promotion Calendar** | ✅ Live | ShopifyQL `GROUP BY discount_code TIMESERIES month`. The "Automatic discounts" row shows only its discount value — its revenue/orders are *not attributable* from this dataset and render as "—", never a guess |
| **Traffic sources (year + monthly) + landing pages** | ✅ Live | ShopifyQL `GROUP BY referrer_name TIMESERIES month` + `landing_page_path` |
| **Voucher performance report (website)** | ✅ Live | Per-code revenue / redemptions / discount value / active window from the discount pulls. `sent` and redemption-rate need the email platform and render "—" until Phase 4 |
| Sales targets (chaser + targets panel) | ⬜ Empty | `lib/targets.js` — hand-maintained, **still blank: fill it in** |
| **Ads tab (Facebook / Google / TikTok)** | ✅ Built (phases 1–3) | `/api/ads` — Meta Marketing API, Google Ads API, TikTok Business API. Awaiting credentials; each platform independently reports `not-configured` until then |
| **Channel mix (Website / Shopee / Lazada)** | ✅ Built (phase 6) | `/api/marketplace` — Shopee + Lazada order pulls, joined with the Shopify revenue series for the Website column. Awaiting partner approvals |
| **Marketplace voucher rows** | ✅ Built (phase 6) | `/api/marketplace` — derived from the same order pull, in the website report's row shape |
| Email (Dotdigital) block + voucher send counts | ⬜ Empty | needs Phase 4 |
| Commission panels | ⬜ Empty | needs Phase 5 (internal eQuip/ECM) |

### Phase 0 implementation notes (for whoever maintains this)
- Transport: order-derived sections (`fulfillment`, `saleMix`) ride the existing full `/api/dashboard` orders pull as `sections:{...}`; ShopifyQL sections (`funnel`, `discounts.monthly`, `traffic.byYear/landing`, `voucherReport`) come from `/api/insights`. Both merge into the front-end's `LIVE_EXTRAS` per brand; each section is individually best-effort with per-section `meta.sections.<key>` reasons.
- Orders are paged at 250/page (measured cost 464 requested / 51 actual vs the 1,000-point single-query cap); the compareAt lookup runs 2 chunks in flight under a 20s budget and fails its section cleanly (`reason:"timeout"`, uncached) rather than timing out the whole payload.
- ShopifyQL throttles the tail of the 11-query insights fan-out on cold, busy loads; the front-end refetches throttled sections up to 3 times with widening spacing. Transient failures are never edge-cached; deterministic ones (e.g. missing scope) are, so a broken scope can't disable caching forever.
- Honesty rules enforced and E2E-tested: no value is ever estimated; unattributable = `null` = "—"; failed ≠ zero (pending states, not zero-claims); cancelled orders excluded from the new sections so they tie to the ShopifyQL KPIs; pickup customers' home districts never counted as delivery regions.
- Watch item: a cold full-year orders pull took ~89s from a home connection (Vercel→Shopify is much faster and `api/dashboard.js` has `maxDuration: 60`, the Hobby-plan ceiling). If the fulfillment/sale-mix sections ever 504 in production on long ranges, either raise `maxDuration` (Pro plan) or narrow the phase-2 window.
- Known UI debt: the discount panel's per-month drill-down view exists and is guarded, but its entry point (the old deck filter) is hidden for live data because the old filter *rescaled* figures. Month-level discount detail is visible via the Promotion Calendar and the "Best Performing Discount" column.
- Newly discovered ShopifyQL dimensions worth future panels (all live-testable with existing keys): `billing_country` / `billing_region` (a REAL sales-by-country split — the old fabricated one was removed), `pos_location_name`, `staff_member_name`, `order_referrer_source`.

---

## Phases 1–3 — ad platforms (BUILT, awaiting credentials)

One endpoint, `/api/ads`, serves the whole tab (the plan originally proposed three
endpoints; the tab needs all three platforms at once, so they fan out inside one function
with per-platform `meta`, exactly like `/api/insights`' sections). Files:

| File | Role |
|---|---|
| `api/ads.js` | fan-out + per-platform `meta`, one calendar year per pull, 45s budget |
| `lib/ads.js` | provider-agnostic roll-up: daily rows → monthly + Mon–Sun weekly series + campaign rows |
| `lib/ads-meta.js` / `lib/ads-google.js` / `lib/ads-tiktok.js` | one client each, all returning the same `{currency, supports, rows, notes}` shape |
| `lib/http.js` | shared REST client: typed reasons, bounded retries, per-attempt timeouts, wall-clock budgets |
| `lib/env-keys.js` | brand → env-var resolution (per-store identifiers, falling-back credentials) |

`npm run preview-ads [brand] [year]` prints exactly what the tab will show.

### Phase 1 — Meta Marketing API (Facebook ads) — what's still needed from Meta
1. **Meta Business Settings → Users → System users**: create a system user (Employee), assign the ad accounts with View-performance access.
2. Business app + Marketing API product → **system-user token** scoped to `ads_read` (long-lived; no App Review for your own accounts).
3. Set `META_ACCESS_TOKEN` and `META_AD_ACCOUNT_<STORE>` (`_SG`/`_MY` accepted for the two iORA stores; comma-separate multiple accounts). **Lead time:** same-day with a Business Manager admin.

Implementation notes: daily campaign insights (`time_increment=1`), paged via `paging.next`, token sent as a Bearer header (never in the query string). Purchases take the FIRST matching action type from `omni_purchase` → `purchase` → `offsite_conversion.fb_pixel_purchase` — summing them would double-count the same purchase. Two accounts reporting different currencies is refused rather than added together. If Meta sunsets `META_API_VERSION`, the client retries once on the Graph default version and says so in `notes`.

### Phase 2 — Google Ads API — what's still needed from Google
1. MCC → **API Center** → developer token → apply for **Basic access** (1–2 weeks).
2. Google Cloud project + OAuth client + refresh token for an MCC reader.
3. Set `GOOGLE_ADS_DEVELOPER_TOKEN`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_REFRESH_TOKEN`, `_LOGIN_CUSTOMER_ID`, `GOOGLE_ADS_CUSTOMER_<STORE>`.

Implementation notes: `googleAds:searchStream` with GAQL over `campaign` × `segments.date`; access token minted per cold start and cached (Google's refresh token does not rotate). Google has no "purchases" metric, so the figures are `metrics.conversions` / `conversions_value` — **every** action the account counts as a conversion. That caveat is served in `notes` and rendered on the panel; the tab's Google table deliberately has no Purchases row. Pin `GOOGLE_ADS_API_VERSION` when Google sunsets the default.

### Phase 3 — TikTok Business API — what's still needed from TikTok
1. TikTok for Business Developers app with the Reporting scope; authorize the advertiser accounts → long-term token + advertiser ids.
2. Set `TIKTOK_ACCESS_TOKEN`, `TIKTOK_ADVERTISER_<STORE>`.

Implementation notes: `/report/integrated/get/`, `report_type=BASIC`, `AUCTION_CAMPAIGN` × `stat_time_day`. TikTok's metric vocabulary shifts between versions and has no stable purchase-value metric, so the client requests only unambiguous names and derives revenue from the first arithmetic the response supports: `TIKTOK_REVENUE_METRIC` if set → `value_per_complete_payment × complete_payment` → `complete_payment_roas × spend` → else **null** ("—"). Whichever applied is stated in `notes`. If the metric list is rejected outright it retries with spend/impressions/clicks so spend stays real and the conversion columns read "—". `TIKTOK_METRICS` overrides the list.

### Phase 4 — Dotdigital (email) — *confirm the platform first*
**Feeds:** Ads tab → Dotdigital block, plus the voucher report's `sent` counts and redemption rates (currently honest "—").
> Confirm marketing is staying on Dotdigital; if moving to Klaviyo, build the same panel against Klaviyo's reporting API instead.
1. Dotdigital **Settings → Access → API users** → API user (Basic auth) + regional base URL.
2. Build `api/email.js`: campaign list + per-campaign send/delivered/open/click stats. **Money stays Shopify-attributed** (UTM-matched orders we already pull) — the ESP only supplies engagement counts.
```
DOTDIGITAL_API_USER=
DOTDIGITAL_API_PASSWORD=
DOTDIGITAL_BASE_URL=
```

### Phase 5 — Commission (internal ECM / eQuip — no public API)
**Feeds:** Commission KPI + store breakdown. Ask IT whether eQuip exposes a reporting API or scheduled export; build `api/commission.js` against it if so. Until then: a validated, hand-maintained `lib/commission.js` mirroring the targets pattern (a copy of the ECM report, labelled with its as-of date — never an estimate).

### Phase 6 — Shopee & Lazada Open Platforms (BUILT, awaiting partner approvals)
**Feeds:** Channel Mix (proven impossible from Shopify alone) and marketplace voucher performance.

| File | Role |
|---|---|
| `api/marketplace.js` | fan-out + per-channel `meta`, 45s budget |
| `lib/shopee.js` | v2 signing, 15-day order windows → 50-per-call order details, rotating-token handling |
| `lib/lazada.js` | REST signing, `/orders/get` paging (order `price` comes back on the list — no detail call) |
| `lib/marketplace.js` | orders → monthly channel series, order counts, totals, voucher rows |
| `lib/token-store.js` | durable storage for the rotating token pairs |

`npm run preview-marketplace [brand] [year]` prints the months, the voucher rows and which
token-store backend is live.

**Still needed from the marketplaces**
- Shopee Open Platform: partner id/key + per-shop authorization → `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY`, `SHOPEE_SHOP_ID_<STORE>`, seed `SHOPEE_ACCESS_TOKEN_<STORE>` + `SHOPEE_REFRESH_TOKEN_<STORE>`.
- Lazada Open Platform: app key/secret + per-country seller authorization → `LAZADA_APP_KEY`, `LAZADA_APP_SECRET`, seed `LAZADA_ACCESS_TOKEN_<STORE>` + `LAZADA_REFRESH_TOKEN_<STORE>`.
- **`TOKEN_STORE_URL` + `TOKEN_STORE_TOKEN` (Upstash-compatible Redis REST).** Not optional in production: both marketplaces invalidate the old refresh token on every refresh, and env vars are read-only at runtime. Without it the rotated pair lives in the instance's temp dir and a redeploy strands it, after which the pull fails with an actionable `reason:"auth"`. `meta.tokenStore` reports the active backend.

**Implementation notes**
- Voucher rows are derived from the SAME order pull (per-order `voucher_code`), not from a voucher endpoint — so a marketplace voucher's sales and redemptions are the orders that actually used it, mirroring how the website report is derived from discount pulls. `sent` and redemption rate stay null ("—"): neither marketplace reports how many vouchers were issued.
- Shopee's order detail may not offer `voucher_code`/`seller_discount` on every API build; a rejection falls back to the safe field set, and the *voucher rows* (never the revenue) are what goes missing — stated in `notes`.
- Cancelled and unpaid orders are pulled but excluded from every figure, matching how the Shopify KPIs exclude cancelled orders; `meta.channels.<ch>.excluded` reports the count so a difference from a raw seller-centre export is explainable.
- **A pull that runs out of budget fails its channel** (`reason:"timeout"`) instead of serving the pages it managed: a half-paged month understates revenue, and a wrong number is worse than a missing one.
- Definitions differ and the panel says so: Website = ShopifyQL gross sales; Shopee/Lazada = the buyer-paid order value each marketplace reports. Do not reconcile them to the cent.
- Roll-up brands (SGALL/MYALL/GROUP) sum their members client-side, with `FX_MYR_SGD` applied for the cross-currency Group — the same rule the sales metrics already use.

### Quick win needing no API at all
Fill `lib/targets.js` from the consolidated ECM targets file — the target chaser and targets panel are fully wired and waiting (`npm test` validates the shape).

---

## Cross-cutting rules (unchanged, now enforced in code)
1. Keys server-side only (`.env` / Vercel env). Nothing in the HTML, ever.
2. Honest failure: `reason:"not-configured"` → empty state; failed ≠ zero; unattributable = null = "—". No placeholders, estimates, or "illustrative" data.
3. Caching: complete payloads edge-cached ~5 min; transient failures `no-store`; deterministic per-section failures don't block caching.
4. Data handling: aggregated only — postal districts (2 chars) are the only address-derived data served, and only for delivery orders.
5. Each new source plugs into the existing overlay: fetch on brand select, per-section meta, merge into `LIVE_EXTRAS`, re-render in place.

## Suggested order
| Phase | What | Code | What's left |
|---|---|---|---|
| ~~0~~ | ~~Shopify: funnel, pickup/delivery, vouchers (web), sale mix, monthly discounts, traffic~~ | ✅ **done** | — |
| ~~1~~ | Meta ads | ✅ **built** | system-user token + ad account ids (same-day) |
| ~~2~~ | Google ads | ✅ **built** | developer-token Basic access (1–2 wks) + OAuth refresh token |
| ~~3~~ | TikTok ads | ✅ **built** | app approval (days) + advertiser ids; confirm metric names against the live account |
| ~~6~~ | Shopee + Lazada | ✅ **built** | partner/seller approvals (weeks) + a Redis token store |
| — | Fill `lib/targets.js` | — | 0.5 day, no API needed |
| 4 | Dotdigital email (+ voucher send counts) | ⬜ | 3 vars, confirm the platform first, 1–2 days |
| 5 | Commission (internal) | ⬜ | ask IT re: eQuip; 0.5 day for the lib file |

### Verifying a credential set once it lands
1. `npm run preview-ads SG` / `npm run preview-marketplace SG` — per-platform output or a
   `not-configured` line naming the exact variables to set.
2. `npm test` — the pure layers (roll-ups, signing, request/error mapping) need no keys.
3. `vercel dev` → open the Ads tab and the Channel Mix panel; a platform that answered but
   had no spend says so, which is different from one that isn't connected.
