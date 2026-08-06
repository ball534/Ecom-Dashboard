# E-commerce Dashboard — Meeting Notes

**Prepared for:** Management review, 7 August 2026
**Covers:** what the dashboard does today, where its data comes from, what is connected vs. pending, and proposed next additions.

---

## 1. What the dashboard is

A single-page web dashboard covering all **eight Shopify Plus stores** across the Group's four brands — iORA, The Restyle Trait (TRT), SANS & SANS and MONOLOQ, in both Singapore and Malaysia. It is hosted on Vercel and pulls data live from Shopify each time it is opened (with a short 5-minute cache).

Three main views:

- **Revenue** — sales performance, year-on-year comparison (2024–2026), product and category analysis, traffic and conversion.
- **Ads Results** — Facebook / Google / TikTok advertising performance (built, awaiting account credentials — see §4).
- **Promotions** — voucher and discount-code performance, promotion calendar.

A brand selector switches between any single store, all-SG, all-MY, or the combined Group view (MY figures converted at a fixed MYR→SGD rate for the roll-up).

**Core principle — no made-up numbers.** Every panel starts blank and only shows figures actually returned by Shopify. Anything unavailable shows a dash ("—") or an empty panel rather than a zero or an estimate. The original design template's demo numbers have all been stripped out.

---

## 2. Where the data comes from

**Live today: Shopify Admin API (GraphQL), all 8 stores connected.** Two channels within it:

1. **ShopifyQL analytics** — the same engine behind Shopify's own Analytics screens. Supplies revenue, orders, units, discounts, customer counts, sessions, conversion rate, best sellers, category mix, discount codes, traffic sources and the marketing funnel.
2. **Orders API** — order-level pulls used to derive things ShopifyQL can't provide: voucher (gift card / store credit) orders, new vs. returning customers, pickup vs. delivery split (by postal district), and sale vs. full-price mix.

iORA SG runs on a permanent access token; the other seven stores mint short-lived (24-hour) tokens automatically on demand.

**Built and tested, but switched off pending access (no development work needed):**

| Source | Feeds | Waiting on |
|---|---|---|
| Meta (Facebook/Instagram) Ads | Ads tab | Ad account credentials |
| Google Ads | Ads tab | Ad account credentials |
| TikTok Ads | Ads tab | Ad account credentials |
| Shopee | Channel Mix + marketplace vouchers | Partner API approval |
| Lazada | Channel Mix + marketplace vouchers | Partner API approval |

**Not integrated at all yet:** see §4.

---

## 3. Data currently on the dashboard (all live from Shopify)

- **Headline KPIs & year-on-year charts** — revenue, orders, average order value, units sold, website sessions, conversion rate, total discounts; monthly / quarterly / full-year views for 2024, 2025 and 2026.
- **Performance summary** — current-year tiles vs. prior year.
- **Brand ranking** (all-brands views) — stores ranked by revenue, orders, AOV, units, sessions and discount usage.
- **SG vs MY comparison** (Group view) — revenue and orders by country and by brand.
- **Best sellers** — top products by revenue/units with product images, plus best sellers by category.
- **Category mix** — revenue by garment category, using Shopify's own product-type field (items without a category set are shown as such, not guessed).
- **Discount & voucher performance** — per-code revenue, orders and discount value; monthly breakdown; promotion calendar; voucher (gift card / store credit) order share.
- **Traffic sources** — sessions by referrer (Google, Facebook, organic, paid…), landing pages, order attribution.
- **Marketing funnel** — sessions → added to cart → reached checkout → purchased.
- **Sale vs. full-price mix** — share of SKUs, items and revenue sold on markdown.
- **Pickup vs. delivery** — split, top collection points, and delivery breakdown by postal district (no personal addresses stored — only the 2-digit district).
- **Sales projection** — actual plus run-rate forecast to year-end, by brand.

---

## 4. What is NOT connected yet

**APIs not yet added (no code exists):**

1. **Email marketing (Dotdigital — or Klaviyo)** — would light up email campaign performance and voucher *sent counts / redemption rates* (these currently show "—"). Blocked on one decision: **confirm which email platform we are staying on** before building.
2. **eQuip POS/CRM (commission / retail)** — no public API is known for eQuip. Next step is to ask IT whether it exposes a reporting API; the fallback is a small hand-maintained data file. The Commission panel exists in the UI but is disabled until then.
3. **TikTok Shop** — no connector available yet; not in the Channel Mix.

**Waiting on inputs, not code:**

- **Sales targets** — Shopify has no concept of targets, so monthly targets per brand must be supplied by the business. Target panels stay hidden until then. *Open question: who owns this?*
- **Ad platform credentials** and **Shopee/Lazada partner approvals** (see §2) — the moment these are provided, those tabs go live automatically.

---

## 5. Proposed additions (for discussion — from DASHBOARD-ADDITIONS.md)

These were verified against our live Shopify account, not taken from documentation.

**A. Available now — just needs building (no new vendors, no extra cost):**

| Addition | What it shows | Effort |
|---|---|---|
| **Returns / return rate** | How much sold product comes back, by month and by product — zero visibility today | Small |
| **Stock sell-through** | % of stock sold, days of cover, days out of stock per product | Medium |
| Sales by country | Real revenue split by customer country/region | Small |
| Online vs. retail split | Sales by channel, POS location and staff member (where Shopify holds them) | Small |
| Extra sales measures | Tax collected, shipping charged, items and AOV direct from Shopify | Small |
| Lapsed customers | Time-since-last-order bands (aggregated, no personal details) | Medium |

Recommended order: **returns first** (direct margin cost, currently invisible), then **stock sell-through** (completes the best-seller picture).

**B. Needs a few hours' investigation before promising:**

- **Profit margin / cost of goods** — *the single most valuable addition if it works; worth prioritising.* Depends on whether cost data is maintained in Shopify.
- On-site search terms (including searches returning no results).
- Campaign attribution (first-click / last-click).
- Delivery speed (order → fulfilment → delivery times).

**C. Not possible — to stop chasing:** sessions by visitor location/device and site-speed metrics. Shopify does not expose these fields; the design template's figures for those panels were placeholder examples, not real data.

**D. Needs a business decision:**

- **Sales targets** — who supplies monthly targets per brand?
- **Product categories** — Category Mix uses Shopify's product-type field; uncategorised products show as "no category set". Fixing this is a merchandising task (fill in the field in Shopify), not a dashboard task. Who owns this?

---

## 6. Known limitations & housekeeping (for transparency)

- **Data accuracy caveats:** orders with more than 100 line items slightly undercount units; new-vs-returning classification is accurate for the current year only; automatic (non-code) discounts can't be attributed per-code, so they show "—"; Shopee/Lazada revenue definitions won't reconcile to the cent with website revenue.
- **Group roll-up FX:** MY figures convert at a fixed, hand-set rate (0.30 MYR→SGD). Fine for comparison; not an accounting number.
- **Long date ranges** can hit the hosting plan's 60-second limit on a cold load (a full-year pull took ~89s in testing). Mitigation: upgrade the Vercel plan or keep windows narrower.
- **Access control:** the dashboard currently has **no login** — anyone with the URL can view it. Worth deciding whether to add a simple access gate given it shows Group sales data.
- If any source fails or is unconfigured, the affected panel shows an honest empty state — a blank never means "zero sales".

---

## 7. Suggested asks for this meeting

1. Approve building **returns** and **stock sell-through** (available now, closes the two biggest gaps).
2. Have someone check whether **cost-of-goods** data exists/can be maintained in Shopify — unlocks profit margin, the highest-value addition.
3. Assign an owner for **monthly sales targets** and for **product categorisation** in Shopify.
4. Provide **ad account credentials** (Meta/Google/TikTok) and progress **Shopee/Lazada partner approvals** — those tabs are already built.
5. Confirm the **email platform** (Dotdigital vs. Klaviyo) so email/voucher-redemption reporting can be scheduled.
