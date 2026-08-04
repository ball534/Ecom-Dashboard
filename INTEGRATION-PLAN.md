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
| Ads tab (Facebook / Google / TikTok) | ⬜ Empty | needs Phase 1–3 |
| Email (Dotdigital) block + voucher send counts | ⬜ Empty | needs Phase 4 |
| Commission panels | ⬜ Empty | needs Phase 5 (internal eQuip/ECM) |
| Channel mix (Website / Shopee / Lazada) | ⬜ Empty | needs Phase 6 — **confirmed impossible from Shopify alone**: every order in the store has `source_name:"web"`; marketplaces never touch Shopify |

### Phase 0 implementation notes (for whoever maintains this)
- Transport: order-derived sections (`fulfillment`, `saleMix`) ride the existing full `/api/dashboard` orders pull as `sections:{...}`; ShopifyQL sections (`funnel`, `discounts.monthly`, `traffic.byYear/landing`, `voucherReport`) come from `/api/insights`. Both merge into the front-end's `LIVE_EXTRAS` per brand; each section is individually best-effort with per-section `meta.sections.<key>` reasons.
- Orders are paged at 250/page (measured cost 464 requested / 51 actual vs the 1,000-point single-query cap); the compareAt lookup runs 2 chunks in flight under a 20s budget and fails its section cleanly (`reason:"timeout"`, uncached) rather than timing out the whole payload.
- ShopifyQL throttles the tail of the 11-query insights fan-out on cold, busy loads; the front-end refetches throttled sections up to 3 times with widening spacing. Transient failures are never edge-cached; deterministic ones (e.g. missing scope) are, so a broken scope can't disable caching forever.
- Honesty rules enforced and E2E-tested: no value is ever estimated; unattributable = `null` = "—"; failed ≠ zero (pending states, not zero-claims); cancelled orders excluded from the new sections so they tie to the ShopifyQL KPIs; pickup customers' home districts never counted as delivery regions.
- Watch item: a cold full-year orders pull took ~89s from a home connection (Vercel→Shopify is much faster and `api/dashboard.js` has `maxDuration: 60`, the Hobby-plan ceiling). If the fulfillment/sale-mix sections ever 504 in production on long ranges, either raise `maxDuration` (Pro plan) or narrow the phase-2 window.
- Known UI debt: the discount panel's per-month drill-down view exists and is guarded, but its entry point (the old deck filter) is hidden for live data because the old filter *rescaled* figures. Month-level discount detail is visible via the Promotion Calendar and the "Best Performing Discount" column.
- Newly discovered ShopifyQL dimensions worth future panels (all live-testable with existing keys): `billing_country` / `billing_region` (a REAL sales-by-country split — the old fabricated one was removed), `pos_location_name`, `staff_member_name`, `order_referrer_source`.

---

## What's left — external sources (no change from original plan except numbering)

### Phase 1 — Meta Marketing API (Facebook ads)
**Feeds:** Ads tab → Facebook weekly + campaign tables (spend, impressions, clicks, purchases, purchase value).
1. **Meta Business Settings → Users → System users**: create a system user (Employee), assign the SG/MY ad accounts with View-performance access.
2. Create a Business app, add the Marketing API product, generate a **system-user token** scoped to `ads_read` (long-lived; no App Review needed for your own accounts).
3. Build `api/ads-meta.js`: `GET graph.facebook.com/{version}/act_{ID}/insights?level=campaign&fields=campaign_name,spend,impressions,clicks,actions,action_values&time_increment=7`. Purchases = `purchase`/`omni_purchase` action; revenue = its `action_values` entry.
```
META_ACCESS_TOKEN=
META_AD_ACCOUNT_SG=act_
META_AD_ACCOUNT_MY=act_
```
**Lead time:** same-day with Business Manager admin.

### Phase 2 — Google Ads API
**Feeds:** Ads tab → Google tables.
1. Manager (MCC) account linking SG/MY → **API Center** → developer token → apply for **Basic access** (1–2 weeks — apply now).
2. Google Cloud project + OAuth client + refresh token for an MCC reader.
3. Build `api/ads-google.js`: `googleAds:searchStream` with GAQL over `campaign` / `segments.date` / `metrics.cost_micros, impressions, clicks, conversions, conversions_value`; roll up weekly server-side.
```
GOOGLE_ADS_DEVELOPER_TOKEN=
GOOGLE_ADS_CLIENT_ID=
GOOGLE_ADS_CLIENT_SECRET=
GOOGLE_ADS_REFRESH_TOKEN=
GOOGLE_ADS_LOGIN_CUSTOMER_ID=
GOOGLE_ADS_CUSTOMER_SG=
GOOGLE_ADS_CUSTOMER_MY=
```

### Phase 3 — TikTok Business API
**Feeds:** Ads tab → TikTok tables.
1. TikTok for Business Developers app with the Reporting scope; authorize advertiser accounts → long-term token + advertiser ids.
2. Build `api/ads-tiktok.js`: `/report/integrated/get/` `report_type=BASIC`, campaign dimensions, daily granularity (confirm metric names against the current API version).
```
TIKTOK_ACCESS_TOKEN=
TIKTOK_ADVERTISER_SG=
TIKTOK_ADVERTISER_MY=
```

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

### Phase 6 — Shopee & Lazada Open Platforms (heaviest lift; registrations take weeks — start them now)
**Feeds:** Channel Mix (proven impossible from Shopify alone) and marketplace voucher performance.
- Shopee Open Platform: partner id/key + per-shop authorization (tokens need refresh plumbing).
- Lazada Open Platform: app key/secret + per-country seller authorization.
- Build `api/marketplace.js`: orders per shop per month → `CHANNELMIX`; voucher endpoints → marketplace voucher rows.
```
SHOPEE_PARTNER_ID=
SHOPEE_PARTNER_KEY=
SHOPEE_SHOP_ID_SG=
SHOPEE_SHOP_ID_MY=
LAZADA_APP_KEY=
LAZADA_APP_SECRET=
LAZADA_ACCESS_TOKEN_SG=
LAZADA_ACCESS_TOKEN_MY=
```

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
| Phase | What | New keys | Blocking approval? | Build effort |
|---|---|---|---|---|
| ~~0~~ | ~~Shopify: funnel, pickup/delivery, vouchers (web), sale mix, monthly discounts, traffic~~ | ~~none~~ | ~~no~~ | ✅ **done** |
| — | Fill `lib/targets.js` | none | no | 0.5 day |
| 1 | Meta ads | 3 vars | no | 1–2 days |
| 2 | Google ads | 7 vars | dev-token review (1–2 wks) | 2–3 days |
| 3 | TikTok ads | 3 vars | app approval (days) | 1–2 days |
| 4 | Dotdigital email (+ voucher send counts) | 3 vars | no (confirm platform) | 1–2 days |
| 5 | Commission (internal) | none yet | ask IT re: eQuip | 0.5 day (lib file) |
| 6 | Shopee + Lazada | 8 vars | partner approval (weeks) | 4–6 days |
