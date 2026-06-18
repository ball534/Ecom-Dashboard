# iORA Live E-commerce Dashboard

A Vercel-deployable webapp that renders the iORA performance dashboard **1-to-1** with
the original `LIVE DASHBOARD ALL BRANDS.html`, but makes it **functional** — pulling live
data from **Shopify** (iORA SG) via a serverless API. Other channels (Lazada, Shopee,
TikTok Shop, Sellercraft) and the other brands are scaffolded as **"Coming soon"** and
will be added in later phases.

## How it works

- **`public/index.html`** — the original dashboard, render code untouched. On load it
  renders its built-in baseline numbers immediately, then calls `/api/dashboard`, overlays
  the live Shopify numbers onto `BRANDS.SG` (overwriting only the months the API returns,
  so baseline/historical months and future months are preserved), recomputes the
  All-Brands/Group aggregates, and re-renders. If the API is unavailable it silently keeps
  the baseline — the page never breaks.
- **`api/dashboard.js`** — Vercel serverless function. Pulls iORA SG orders from the
  Shopify Admin GraphQL API server-side (token stays secret), aggregates them into the
  dashboard's `{metric: {year: [12 months]}}` shape, and returns JSON. CDN-cached 15 min.
- **`api/_shopify.js`** — minimal Shopify Admin GraphQL client (zero deps).
- **`lib/aggregate.js`** — pure aggregation math (order → monthly buckets, aggregates).
- **`scripts/`** — `verify-token.js` (auth check) and `test.js` (unit tests).

A small status chip in the header shows **Live · Shopify · N mo** when live data loaded,
or **Baseline data** with the reason when it didn't.

### What is live vs. coming soon (Shopify-only phase)

| Live now (iORA SG, current year) | Coming soon (badged) |
|---|---|
| Revenue, Orders, Units, Discounts | Channel Mix (Shopee/Lazada/TikTok) |
| Voucher orders, New vs Returning customers | Sales Targets, Sale vs Full-price |
| Live Summary tiles + Key Metrics | Sessions / Traffic / Funnel (Analytics API) |
| | Best Sellers / Category (product pull) |
| | 2024–2025 history (needs `read_all_orders`) |
| | The other 7 brands |

## ✅ Token status (as of 2026-06-18)

The key in `.env` is a valid `shpat_` Admin API token — `npm run verify-token` authenticates
against **iORA** (`iora-online.myshopify.com`, SGD, `Asia/Singapore`). Live data flows.

### How the numbers are defined (so they tally with the Shopify admin)

The aggregation matches Shopify's own Analytics reports. Only **test orders** are excluded
(cancelled orders are kept — Shopify's items/sales reports count them, and revenue uses the
current total so any refund on them already nets out):

| Metric | Definition | Verified (Jan 1–Jun 18 2026) |
|---|---|---|
| **Gross Sales** (`rev`) | Shopify "Gross sales" = product price × qty, **before** discounts/returns/tax/shipping. Prices are tax-inclusive (SG GST), so we strip the embedded tax per line at its own rate. | ~530,253 vs **529,494** (≈0.1%) |
| **Orders** (`ord`) | Count of non-test orders. | 7,664 vs **7,654** |
| **Units** (`uni`) | **Gross** quantity ordered — Shopify's "Items ordered" (`quantity_ordered`). Does **not** subtract refunds or exclude cancelled. | 22,335 vs **22,334** |
| **Avg Order Value** | (Gross Sales − discounts) ÷ orders — a **net** basis (computed in the front-end tile). | 62.50 vs **62.88** |
| **Discounts** (`dis`) | `currentTotalDiscounts` — net of refunded discount. | — |
| **Voucher** (`vou`) | Orders that redeemed a **gift card / store credit** (`paymentGatewayNames`). ⚠️ *Not* "orders with a discount code" — far narrower (≈70/yr). | — |
| **New / Returning** (`cust`/`ret`) | **Distinct customers** per month. "New" = first-ever order is in-month; else "Returning". See `classifyNewReturning`. | — |

Small residuals vs the admin are **live drift** (orders placed between snapshots) plus tax/discount
approximation. Money metrics are reconstructed from the Orders API and are within ~1%, not exact.

> Cancelled orders are **kept** (Shopify's items/sales reports count them; refunds net out via the
> current discount/quantity). Only **test orders** are excluded.

### What the Shopify Admin API can and cannot provide

These come straight from the Orders/Customers API: **Gross Sales, Orders, Units, Discounts, Voucher
(gift-card), New/Returning customers, AOV** (derived). Also readable but not yet surfaced: products,
inventory, returns, gift cards, markets, channels, marketing events, abandoned checkouts, metaobjects.

**Not available via the Admin API — at all, regardless of scope:** **Sessions** and **Conversion
rate**. These are web-analytics metrics that live only in the Shopify *Analytics* page (powered by
ShopifyQL, which Shopify removed from the Admin API — tested & rejected on API versions 2024-04
through 2025-04). `read_analytics`/`read_reports` are in the token's scopes but **add no API fields**
for them. The dashboard therefore shows Sessions & Conversion as **dashes (n/a)**. To populate them
you'd need a separate source (the Analytics UI/export, a GA4 integration, or manual entry).

Run `npm run preview` to print the live month-by-month numbers and eyeball them against the admin.

### Date range (live)

The header has **From / To** date pickers (default: 1 Jan of the current year → today).
Changing either re-queries Shopify for that window and re-renders in place. The endpoint
accepts `GET /api/dashboard?start=YYYY-MM-DD&end=YYYY-MM-DD` and buckets by month across any
years the range spans. Months outside the selected range render as dashes (`–`). While a
request is in flight, the live metrics show **dashes** rather than stale baseline numbers, so
it's always clear whether live data has loaded. (Ranges spanning prior years need
`read_all_orders`, which the app now has; see the new/returning caveat below.)

### Getting a working token (`shpat_`)

1. In the **iORA SG** Shopify admin: **Settings → Apps and sales channels → Develop apps**.
2. **Create an app** (e.g. "Dashboard Read").
3. **Configure Admin API scopes**: enable `read_orders` and `read_products`. For data older
   than 60 days also request **`read_all_orders`** (Shopify approval required). For new-vs-
   returning customers you may need **protected customer data** access (request in the app).
4. **Install app**, then **reveal the Admin API access token** — it starts with `shpat_`.
5. Put it in `.env` as `SHOPIFY_TOKEN` (and in Vercel env vars for production).
6. Confirm the store domain in `SHOPIFY_STORE_DOMAIN` (auto-detected: `iora-online.myshopify.com`).

## Setup & run

```bash
# 1. Install Vercel CLI (only needed for local dev / deploy)
npm i -g vercel

# 2. Configure secrets (already scaffolded in .env — replace the token)
#    SHOPIFY_TOKEN, SHOPIFY_STORE_DOMAIN, SHOPIFY_API_VERSION

# 3. Check the token authenticates
npm run verify-token

# 4. Run the unit tests (no token needed)
npm test

# 5. Local dev (serves public/ + runs api/ functions)
vercel dev
#    open http://localhost:3000

# 6. Deploy
vercel            # preview
vercel --prod     # production
```

On Vercel, set `SHOPIFY_TOKEN`, `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_API_VERSION` under
**Project → Settings → Environment Variables**. **Never commit `.env`** (it is gitignored).

## Verification checklist

- `npm test` → all unit tests pass (aggregation math + tallies).
- `npm run verify-token` → ✅ once a valid `shpat_` token is set (currently ❌ auth).
- `vercel dev` → dashboard renders; with a valid token the header chip shows "Live · Shopify",
  SG current-year numbers match the Shopify admin Orders report, non-live panels show
  "Coming soon"; with a bad/missing token it shows "Baseline data" and still renders fully.

## Notes / current limitations

- Orders are fetched by cursor pagination (250/page). For very large multi-year pulls,
  switch to Shopify **Bulk Operations** (the aggregation logic in `lib/aggregate.js` is
  unchanged). Line items are read 100/order — orders with >100 lines would undercount units.
- New-vs-returning is accurate **only while `LIVE_YEAR` is the current year** (the method
  assumes a customer's out-of-window orders are necessarily prior, which holds when there
  are no future orders). For historical years, classification would need a first-order-date
  map built from `read_all_orders`.
- `LIVE_YEAR` in `api/dashboard.js` is `2026`; bump it each January (or derive from shop date).
- Timezone: order months are bucketed in `Asia/Singapore`.

## Roadmap (next integrations)

1. Shopify: products/best-sellers, category mix, sessions/funnel (Analytics API), full history.
2. Sellercraft API (consolidates Shopee/Lazada/TikTok) → Channel Mix + marketplace revenue.
3. Other brands (TRT, SANS, Monoloq) SG + MY; sales targets ingestion.
