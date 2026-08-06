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
| **Sessions, Conversion** (ShopifyQL) | Sale vs Full-price |
| Voucher orders, New vs Returning customers | Marketing funnel steps (cart/checkout breakdowns) |
| At-a-Glance hero + Key Numbers | Ads spend / ROAS (needs ad-platform APIs) |
| **Best Sellers (SKU + product), Category Mix** | The other 7 brands |
| **Discount-code performance, Traffic attribution** | |
| Sales Targets (from `lib/targets.js`, once filled in) | |

### UI: tabs + At-a-Glance (2026-07 redesign)

The page opens with an **At a Glance** hero — headline tiles with like-for-like
year-on-year chips (same calendar months, both years) and **auto-written insight
bullets** (sales headline, pace vs target, biggest YoY mover, top discount code,
best seller, traffic anomalies). Below it, panels are organised into tabs:
**Overview · Sales · Marketing · Products · Customers**. KPI chips use the same
like-for-like YoY rule as the hero, so the two always agree. Dense tables are
folded behind "Show table" toggles; the charts stay visible.

### `/api/insights` — the insight sections

`GET /api/insights?brand=SG&start=YYYY-MM-DD&end=YYYY-MM-DD&limit=10` returns, in
one round trip: best sellers (by SKU + by product title), discount-code
performance, category mix, traffic attribution (referrers, order sources, UTM
campaigns) and sales targets. All six ShopifyQL calls run in parallel
(`Promise.allSettled`); a failed section returns `null` with a reason in
`meta.sections.<key>` — the payload never 500s. See `lib/insights.js` (pure
builders/parsers, unit-tested) and `api/insights.js`.

**Two files the team maintains by hand** (validated by `npm test`):

- **`lib/category-map.js`** — SKU prefix → category (Shopify `product_type` is
  mostly blank on this store; SKU chars 3–4 encode the category, e.g. `AFBS` =
  blouse). Run `npm run preview-insights` to see the top **unmapped** prefixes
  ranked by gross sales, then add them here.
- **`lib/targets.js`** — monthly sales targets per brand/year (`{year: [12]}`,
  null = no target). Feeds the Sales tab's Target vs Actual panel and the
  "tracking ahead/behind target" insight bullet.

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

## Shopify scopes required

Read-only. Every scope below is traceable to a specific call in `api/_shopify.js`:

| Scope | Needed for |
|---|---|
| `read_reports` | `shopifyqlQuery` — all the `FROM sales` / `FROM sessions` / `FROM fulfillments` queries in `lib/shopifyql.js` and `lib/insights.js` |
| `read_analytics` | the `FROM sessions` datasets (sessions, conversion_rate, referrer_source, utm_campaign) |
| `read_orders` | `fetchOrders()` — Units, Voucher, New/Returning, and the sales fallback path |
| `read_all_orders` | without it the Orders path only reaches back **60 days**. Requires Shopify approval |
| `read_customers` | `customer { id numberOfOrders }` in `ORDERS_QUERY` — drives new-vs-returning |
| `read_products` | `fetchProductImagesByTitle()` — best-seller thumbnails via `products(query: "title:…")` |

```
read_reports, read_analytics, read_orders, read_all_orders, read_customers, read_products
```

Plus **protected customer data** access, requested inside the app config — it is *not* a
scope checkbox, and `read_customers` alone won't return customer fields without it. Denial
degrades gracefully: `ShopifyError` with `reason: "scope"` and the panel shows dashes.

`rights.md` records the full scope list currently granted on the store; it is a superset of
the above (most of it is unused by this repo). Note that `FROM fulfillments` goes through
ShopifyQL/`read_reports` — the fulfillment scopes are **not** needed. Neither is
`read_discounts`: discount-code performance also comes from ShopifyQL.

### Getting a working token (`shpat_`)

1. In the **iORA SG** Shopify admin: **Settings → Apps and sales channels → Develop apps**.
2. **Create an app** (e.g. "Dashboard Read").
3. **Configure Admin API scopes**: enable the six listed above, then request **protected
   customer data** access in the same app config.
4. **Install app**, then **reveal the Admin API access token** — it starts with `shpat_`.
5. Put it in `.env` as `TOKEN_IORASG` (and in Vercel env vars for production).
6. Confirm the store domain in `DOMAIN_IORASG` (auto-detected: `iora-online.myshopify.com`).

Repeat per store, using that store's own admin. Note that only iORA SG's app hands out a
permanent token — for the other seven, take the app's **client id + client secret** instead
and put them in `CLIENT_<STORE>`/`SECRET_<STORE>`; the API then mints its own 24-hour tokens
(see **Expiring tokens** below). Store suffixes are in the table below.

## Setup & run

```bash
# 1. Install Vercel CLI (only needed for local dev / deploy)
npm i -g vercel

# 2. Configure secrets: cp .env.example .env, then fill it in — one
#    SHOPIFY_API_VERSION, a DOMAIN_ per store, plus TOKEN_IORASG and a
#    CLIENT_/SECRET_ pair for the seven stores with expiring tokens

# 3. Check the credentials authenticate (mints a token where needed)
npm run verify-token                 # iORA SG
node scripts/verify-token.js TRTSG   # any other store

# 4. Run the unit tests (no token needed)
npm test

# 5. Local dev (serves public/ + runs api/ functions)
vercel dev
#    open http://localhost:3000

# 6. Deploy
vercel            # preview
vercel --prod     # production
```

### Environment variables

All eight stores share one Admin API version; each store has its own token + permanent
domain. Set these under **Project → Settings → Environment Variables** on Vercel (and in
`.env` locally — see `.env.example` for the annotated template).

| Variable | Store | Brand key |
| --- | --- | --- |
| `SHOPIFY_API_VERSION` | shared by all stores (`2025-10`) | — |
| `TOKEN_IORASG` / `DOMAIN_IORASG` | iORA SG (permanent token) | `SG` |
| `CLIENT_IORAMY` / `SECRET_IORAMY` / `DOMAIN_IORAMY` | iORA MY | `MY` |
| `CLIENT_TRTSG` / `SECRET_TRTSG` / `DOMAIN_TRTSG` | The Restyle Trait SG | `TRTSG` |
| `CLIENT_TRTMY` / `SECRET_TRTMY` / `DOMAIN_TRTMY` | The Restyle Trait MY | `TRTMY` |
| `CLIENT_SANSSG` / `SECRET_SANSSG` / `DOMAIN_SANSSG` | SANS & SANS SG | `SANSSG` |
| `CLIENT_SANSMY` / `SECRET_SANSMY` / `DOMAIN_SANSMY` | SANS & SANS MY | `SANSMY` |
| `CLIENT_MONOSG` / `SECRET_MONOSG` / `DOMAIN_MONOSG` | MONOLOQ SG | `MONOSG` |
| `CLIENT_MONOMY` / `SECRET_MONOMY` / `DOMAIN_MONOMY` | MONOLOQ MY | `MONOMY` |

Every store also still accepts a plain `TOKEN_<STORE>`, which takes precedence over its
`CLIENT_`/`SECRET_` pair (see **Expiring tokens** below).

Resolved by `resolveConfig()` in `api/_shopify.js`. Notes:

- The **brand key** is the dashboard's internal id (`/api/dashboard?brand=SG`). It matches
  the env suffix for every store except the two iORA ones: brand `SG` → `TOKEN_IORASG`,
  brand `MY` → `TOKEN_IORAMY`.
- **Domain** = the store's permanent `<handle>.myshopify.com`, *not* the public storefront.
- A store whose pair is left **empty** is skipped: `/api/dashboard` returns
  `reason: "not-configured"`, that store's figures stay blank (dashes), and it drops out of
  the SG/MY/Group roll-ups — quietly, with no warning banner. Setting a wrong or
  placeholder value is worse: the store counts as live and fails on auth.
- The two values are easy to enter the wrong way round. `getConfig()` recognises a
  transposed pair (a `<handle>.myshopify.com` in `TOKEN_*` and a `shp…_` token in
  `DOMAIN_*`), reads it swapped so live data still loads, and logs a one-line warning
  naming the pair. Transpose the values in `.env`/Vercel to clear the warning — without
  the guard the token is used as a hostname and the store fails with the misleading
  `reason: "http"` ("Network error reaching Shopify").
- Legacy names are still accepted as a fallback so an existing deployment keeps working:
  `SHOPIFY_TOKEN`/`SHOPIFY_KEY` + `SHOPIFY_STORE_DOMAIN` for iORA SG, and
  `SHOPIFY_TOKEN_<BRAND>` + `SHOPIFY_DOMAIN_<BRAND>`/`SHOPIFY_STORE_DOMAIN_<BRAND>` for the
  rest. A single store can override the shared version with `SHOPIFY_API_VERSION_<BRAND>`.

**Never commit `.env`** (it is gitignored, as is `oauth/`).

### Expiring tokens: the API mints its own

Only **iORA SG**'s app issues a permanent `shpat_` token. The other seven stores' apps issue
tokens that **expire after ~24 hours**, which used to mean re-running `oauth/main.py` and
re-uploading eight variables to Vercel every day.

That is no longer necessary. `api/_token.js` performs the same OAuth **client_credentials**
exchange the script did, inside the serverless function, at request time:

```
POST https://<shop>.myshopify.com/admin/oauth/access_token
     grant_type=client_credentials&client_id=<CLIENT_…>&client_secret=<SECRET_…>
  → { access_token: "shpat_…", expires_in: 86399 }
```

The `client_id` / `client_secret` pair **never expires**, so those are the only credentials
Vercel holds. Behaviour:

- **Precedence** — `TOKEN_<STORE>` set → used verbatim (iORA SG). Otherwise, if
  `CLIENT_<STORE>` + `SECRET_<STORE>` are set → a token is minted. Otherwise the store
  reports `reason: "not-configured"` exactly as before.
- **Caching** — a minted token is held in the lambda's module scope until 10 minutes before
  its expiry, so a warm instance mints once (not once per request); concurrent requests for
  the same store share a single in-flight mint. A cold start mints again — one extra ~200 ms
  call. Vercel instances don't share memory, so if that volume ever matters, swap the `Map`
  in `api/_token.js` for Vercel KV; nothing else changes.
- **Mid-request expiry** — if Shopify answers `401` on a minted token (rotated credentials,
  app reinstalled, or a long multi-year pull straddling the expiry), the query re-mints once
  and retries automatically. `403` is left alone: that's a missing scope, which a new token
  can't fix.
- **Failure** — a rejected `client_id`/`secret` surfaces as `meta.reason: "auth"` with the
  Shopify response in `meta.message`, not a 500.
- **Naming** — the `<STORE>_CLIENT` / `<STORE>_SECRET` / `<STORE>_DOMAIN` spelling used by
  `oauth/.env` is also accepted, so that file's contents can be pasted into Vercel unchanged.

Check any store end to end (mints, then calls the Admin API):

```bash
npm run verify-token                 # iORA SG
node scripts/verify-token.js TRTSG   # any other store
```

`oauth/main.py` is now redundant — kept only as a reference for the grant. It contains live
client secrets, so `oauth/` is gitignored.

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
