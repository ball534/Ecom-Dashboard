# iORA Live E-commerce Dashboard

A Vercel-deployable webapp that renders the iORA performance dashboard **1-to-1** with
the original `LIVE DASHBOARD ALL BRANDS.html`, but makes it **functional** — pulling live
data from **Shopify** (iORA SG) via a serverless API. Other channels (Lazada, Shopee,
TikTok Shop, Sellercraft) and the other brands are scaffolded as **"Coming soon"** and
will be added in later phases.

## How it works

- **`public/index.html`** — the dashboard, render code untouched. **All baked-in
  ("baseline") numbers were removed** — the data objects (`BRANDS`, `DISCOUNTS`,
  `CHANNELMIX`, `PRODUCTS`/`PROD_*`, `CAT_REV*`, `SESSIONSRC`, `SALEMIX`, `FUNNEL`, …)
  ship empty. On load the page is blank until it calls `/api/dashboard` and fills
  **iORA SG** with live Shopify numbers, then recomputes aggregates and re-renders.
  Everything not backed by the live API (the other 7 brands, prior years, Sessions,
  Conversion, Targets, Best Sellers, Channel Mix, …) renders an honest "no data / not
  connected" state — never a fabricated figure. If the API is unavailable the live
  metrics show dashes (not stale numbers).
- **`api/dashboard.js`** — Vercel serverless function. Server-side (token stays secret) it
  pulls **ShopifyQL** analytics (`shopifyqlQuery`) for the exact sales + sessions figures and
  the Orders API for the rest, aggregates into the dashboard's `{metric: {year: [12 months]}}`
  shape, and returns JSON. CDN-cached 15 min.
- **`api/_shopify.js`** — minimal Shopify Admin GraphQL client (zero deps): `fetchOrders`,
  `shopifyQL` (ShopifyQL runner), and `verifyToken`.
- **`lib/aggregate.js`** — pure aggregation math for the Orders path (order → monthly buckets).
- **`lib/shopifyql.js`** — pure parser that turns ShopifyQL table rows into the metric shape.
- **`scripts/`** — `verify-token.js` (auth check), `verify-shopifyql.js` (ShopifyQL/version
  probe), `preview.js` (live month-by-month), and `test.js` (unit tests).

A small status note in the header surfaces only problems (e.g. "Live data unavailable
(reason)"); on success the live numbers simply appear (dashes while a request is in flight).

### What is live vs. coming soon (Shopify-only phase)

| Live now (iORA SG, current year) | Coming soon (badged) |
|---|---|
| Revenue, Orders, Units, Discounts | Channel Mix (Shopee/Lazada/TikTok) |
| **Sessions, Conversion** (ShopifyQL) | Sales Targets, Sale vs Full-price |
| Voucher orders, New vs Returning customers | Traffic sources / Funnel (needs session breakdowns) |
| Live Summary tiles + Key Metrics | Best Sellers / Category (product pull) |
| | 2024–2025 history (needs `read_all_orders`) |
| | The other 7 brands |

## ✅ Token status (as of 2026-06-18)

The key in `.env` is a valid `shpat_` Admin API token — `npm run verify-token` authenticates
against **iORA** (`iora-online.myshopify.com`, SGD, `Asia/Singapore`). Live data flows.

### Where each number comes from (so they tally with the Shopify admin)

Two server-side sources, both via the **same Admin API + `shpat_` token** — **no Claude/MCP at runtime:**

- **ShopifyQL** (`shopifyqlQuery`, the engine behind the admin Analytics page) → the **exact** figures,
  no reconstruction: **Gross Sales** (`rev`), **Discounts** (`dis`), **Orders** (`ord`), **Sessions**
  (`ses`), **Conversion** (`conversion`). See `lib/shopifyql.js`.
- **Orders API** → **Units** (`uni`), **Voucher** (`vou`), **New/Returning customers** (`cust`/`ret`),
  which ShopifyQL doesn't expose as clean columns. See `lib/aggregate.js`.

| Metric | Definition |
|---|---|
| **Gross Sales** (`rev`) | ShopifyQL `gross_sales` — product price × qty before discounts/returns/tax/shipping. Exact match to the admin. |
| **Orders** (`ord`) | ShopifyQL `orders` (matches the admin; excludes cancelled, unlike a raw order count). |
| **Discounts** (`dis`) | ShopifyQL `discounts` (reported negative; stored as a positive magnitude). |
| **Avg Order Value** | (Gross Sales − discounts) ÷ orders, computed in the front-end tile — equals ShopifyQL `average_order_value`. |
| **Sessions** (`ses`) | ShopifyQL `sessions` — storefront visits. |
| **Conversion** (`conversion`) | ShopifyQL `conversion_rate`; aggregated session-weighted (Σ rate·sessions ÷ Σ sessions) so quarter/year totals match the admin. |
| **Units** (`uni`) | Orders API — **gross** quantity ordered ("Items ordered"); not net of refunds. |
| **Voucher** (`vou`) | Orders API — orders that redeemed a **gift card / store credit** (`paymentGatewayNames`). ⚠️ *Not* "orders with a discount code". |
| **New / Returning** (`cust`/`ret`) | Orders API — **distinct customers** per month; "New" = first-ever order is in-month. See `classifyNewReturning`. |

Residuals vs the admin are **live drift** — orders placed between when the Analytics page was viewed and
when the dashboard queried (the store takes orders all day).

### ShopifyQL needs API version ≥ 2025-10

`shopifyqlQuery` is **not present** on Admin API versions ≤ 2025-07 — which is why an earlier note here
wrongly concluded ShopifyQL was "removed." It was (re)introduced in **2025-10**; the token already holds
`read_reports`/`read_analytics`, and the store is on **Shopify Plus**, so it works. `SHOPIFY_API_VERSION`
is pinned to `2025-10`.

**Fallback:** if `shopifyqlQuery` is ever unavailable (older API version, or a token without reports
access), `api/dashboard.js` falls back to reconstructing `rev`/`dis`/`ord` from the Orders API line items
(tax stripped per line) and Sessions/Conversion show **dashes**. `meta.salesSource`
(`shopifyql` | `reconstructed`) and `meta.sessionsLive` report which path was taken.

Run `npm run verify-shopifyql` to confirm ShopifyQL access + the working API version, and
`npm run preview` to print the live month-by-month numbers and eyeball them against the admin.

### Date range (live)

The header has **From / To** date pickers (default: 1 Jan of the current year → today).
Changing either re-queries Shopify for that window and re-renders in place. The endpoint
accepts `GET /api/dashboard?start=YYYY-MM-DD&end=YYYY-MM-DD` and buckets by month across any
years the range spans. Months outside the selected range render as dashes (`–`). While a
request is in flight, the live metrics show **dashes**, so it's always clear whether live data
has loaded. Selecting a range that spans prior years pulls those live too (the token has
`read_all_orders`), though new-vs-returning is only accurate for the current year — see the caveat below.

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

- `npm test` → all unit tests pass (Orders + ShopifyQL parsing).
- `npm run verify-token` → ✅ the `shpat_` token authenticates against iORA SG.
- `npm run verify-shopifyql` → ✅ `shopifyqlQuery` returns live sales + sessions; prints the
  lowest API version that works (pin `SHOPIFY_API_VERSION` to it).
- `vercel dev` → dashboard renders; with a valid token the iORA SG current-year numbers — including
  **Sessions & Conversion** — match the Shopify Analytics page (within live drift), and every
  non-live panel/brand shows an honest "no data" state; with a bad/missing token the live metrics
  show dashes (no fabricated numbers).

## Notes / current limitations

- Orders are fetched by cursor pagination (250/page). For very large multi-year pulls,
  switch to Shopify **Bulk Operations** (the aggregation logic in `lib/aggregate.js` is
  unchanged). Line items are read 100/order — orders with >100 lines would undercount units.
- New-vs-returning is accurate **only for the current year** (the method assumes a customer's
  out-of-window orders are necessarily prior, which holds when there are no future orders). For
  historical years, classification would need a first-order-date map built from `read_all_orders`.
- The default window is the current calendar year to date, derived from the shop's date
  (`Asia/Singapore`) in `api/dashboard.js` — no hardcoded year to bump.
- Timezone: order months are bucketed in `Asia/Singapore`.

## Roadmap (next integrations)

1. Shopify: products/best-sellers, category mix, traffic-source & funnel breakdowns (ShopifyQL
   `GROUP BY` on sessions), full history.
2. Sellercraft API (consolidates Shopee/Lazada/TikTok) → Channel Mix + marketplace revenue.
3. Other brands (TRT, SANS, Monoloq) SG + MY; sales targets ingestion.
