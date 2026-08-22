# Ecom Dashboard

**One dashboard. Six platforms. No made-up numbers.**

A live performance dashboard for a multi-brand fashion retailer operating eight Shopify Plus
storefronts across Singapore and Malaysia. It pulls revenue, funnel, traffic, discount,
fulfilment, ad-spend and marketplace data straight from first-party APIs — and renders an
honest blank wherever a source genuinely cannot answer.

### What it connects to

| Source                                 | What it feeds                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shopify (ShopifyQL + Orders + GraphQL) | Revenue, orders, AOV, sessions, conversion, funnel, best sellers, traffic attribution, discount performance, pick-up vs delivery, sale vs full-price mix |
| Meta Marketing API                     | Facebook ad spend, impressions, clicks, purchases                                                                                                        |
| Google Ads API                         | Google campaign spend and conversions                                                                                                                    |
| TikTok Business API                    | TikTok campaign performance                                                                                                                              |
| Shopee Open Platform                   | Marketplace orders and voucher performance                                                                                                               |
| Lazada Open Platform                   | Marketplace orders and voucher performance                                                                                                               |

### How it is built

- **One serverless function per source** on Vercel. The browser only ever calls our own `/api/*` endpoints — no credential ever reaches client-side JavaScript.
- **Per-section failure.** Each panel carries its own `meta` state, so a throttled ShopifyQL query or a missing ad account degrades one card instead of the page.
- **Honest data contract.** Unattributable → `null` → "—". Failed ≠ zero. Unconfigured → an empty state naming the exact environment variables to set. No estimates, ever.
- **Deliberate cost control.** Orders paged at 250, compare-at-price lookups batched under a wall-clock budget, complete payloads edge-cached ~5 minutes while transient failures are never cached.

### Engineering notes worth reading

The Shopee and Lazada clients both handle **rotating refresh tokens** — each marketplace
invalidates the old token on every refresh, and serverless environment variables are read-only
at runtime, so the rotated pair is persisted to a Redis-compatible token store rather than
lost on redeploy.

The ad clients each normalise to one `{currency, supports, rows, notes}` shape, and where a
platform has no unambiguous metric — TikTok purchase value, or Google "conversions" meaning
every action the account counts — the panel says so in plain language instead of quietly
presenting a number that means something else.
