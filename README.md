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

## ⚠️ Token status (as of 2026-06-17)

The key in `.env` starts with **`atkn_`**. It was **tested and REJECTED (HTTP 401)** by
Shopify on both REST and GraphQL endpoints — **it is not a valid Shopify Admin API token.**
The store backend was auto-detected as `iora-online.myshopify.com` (a real Shopify store —
it returned 401 rather than 404). The app is fully built and will work as soon as a valid
token is supplied. Until then the dashboard runs on baseline data.

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
- New-vs-returning uses `customer.numberOfOrders` (lifetime as-of-now) — a v1 approximation.
- `LIVE_YEAR` in `api/dashboard.js` is `2026`; bump it each January (or derive from shop date).
- Timezone: order months are bucketed in `Asia/Singapore`.

## Roadmap (next integrations)

1. Shopify: products/best-sellers, category mix, sessions/funnel (Analytics API), full history.
2. Sellercraft API (consolidates Shopee/Lazada/TikTok) → Channel Mix + marketplace revenue.
3. Other brands (TRT, SANS, Monoloq) SG + MY; sales targets ingestion.
