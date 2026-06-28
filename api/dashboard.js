// api/dashboard.js
// Vercel serverless endpoint. Pulls live iORA SG orders from Shopify for a date
// range, aggregates them into the dashboard's metric shape, and returns JSON the
// front-end overlays onto its baseline. Never exposes the token to the browser.
//
// Query params (optional):
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD   — defaults to (current year)-01-01 .. today
//
// Success  -> { SG: {rev,ord,uni,dis,vou,cust,ret,ses,conversion}, meta:{ live:true, ... } }
// Failure  -> { SG: {}, meta:{ live:false, reason } }                          (not cached)
//
// Data sources (both via the same Admin API + token — no Claude/MCP at runtime):
//   • rev, dis, ord, uni, cust, ret, ses, conversion — ShopifyQL (`shopifyqlQuery`): the
//     exact figures from the admin Analytics engine. If ShopifyQL is unavailable (older API
//     version / missing reports access) rev/dis/ord/uni/cust/ret fall back to the Orders
//     reconstruction and ses/conversion stay absent (front-end shows dashes).
//   • vou                              — Orders API (gift-card/store-credit orders; ShopifyQL
//     has no clean column for this).

import { getConfig, fetchOrders, shopifyQL, ShopifyError } from "./_shopify.js";
import { bucketOrders, monthsWithData, emptyYear, ORDER_METRICS } from "../lib/aggregate.js";
import {
  buildSalesQL,
  buildSessionsQL,
  buildFulfillmentsQL,
  bucketSales,
  bucketSessions,
  bucketFulfillments,
} from "../lib/shopifyql.js";

// An all-null metrics skeleton (no Orders API pull). Used by `light` mode, where the
// front-end wants the exact ShopifyQL Analytics figures across a multi-year range
// without paging tens of thousands of orders for the `vou` reconstruction.
function emptyMetrics(years) {
  const out = {};
  for (const m of [...ORDER_METRICS, "ordf"]) {
    out[m] = {};
    for (const y of years) out[m][y] = emptyYear();
  }
  return out;
}

const SHOP_TZ = "Asia/Singapore";
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// "Today" as YYYY-MM-DD in the shop's timezone (en-CA formats as ISO date).
function todayInTZ(tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export default async function handler(req, res) {
  const cfg = getConfig();
  const today = todayInTZ(SHOP_TZ);
  const q = req.query || {};

  // Resolve + sanitize the requested window. Default: this calendar year to date.
  let start = isDate(q.start) ? q.start : `${today.slice(0, 4)}-01-01`;
  let end = isDate(q.end) ? q.end : today;
  if (start > end) [start, end] = [end, start]; // tolerate swapped inputs

  // `light=1` skips the Orders API pagination entirely and returns ONLY the ShopifyQL
  // Analytics figures. The dashboard uses it to load full multi-year history fast (one
  // round trip per dataset) for the year-on-year chart, without risking a cold-start
  // timeout while paging orders. `vou` (gift-card/store-credit orders) is omitted in
  // this mode since it has no ShopifyQL column.
  const light = q.light === "1" || q.light === "true";

  const years = [];
  for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) years.push(y);

  try {
    // Try with customer data (new vs returning). If the app lacks protected-
    // customer-data approval, retry without it so the other metrics still load.
    let includeCustomer = true;
    let result = { orders: [], truncated: false };
    if (!light) {
      try {
        result = await fetchOrders(cfg, { start, end, includeCustomer });
      } catch (e) {
        if (e instanceof ShopifyError && e.reason === "scope") {
          includeCustomer = false;
          result = await fetchOrders(cfg, { start, end, includeCustomer });
        } else {
          throw e;
        }
      }
    }

    const metrics = light
      ? emptyMetrics(years)
      : Object.assign(bucketOrders(result.orders, { years, timeZone: SHOP_TZ }), {
          ordf: Object.fromEntries(years.map((y) => [y, emptyYear()])),
        });

    // Overlay the exact Analytics figures from ShopifyQL where available. These are
    // independent best-effort calls: if either is unavailable (e.g. an Admin API
    // version < 2025-10, or a token without reports access) we keep the Orders-based
    // numbers and the front-end simply shows dashes for Sessions/Conversion.
    let salesSource = "reconstructed";
    let sessionsLive = false;
    let shopifyqlError = null;

    try {
      const { rows } = await shopifyQL(cfg, buildSalesQL(start, end));
      const sales = bucketSales(rows, years);
      // Authoritative — replace the Orders-reconstructed metrics outright. These match the
      // admin Analytics page exactly (no cancelled-order or first-time/returning drift).
      for (const y of years) {
        metrics.rev[y] = sales.rev[y];
        metrics.dis[y] = sales.dis[y];
        metrics.ord[y] = sales.ord[y];
        metrics.uni[y] = sales.uni[y];
        metrics.cust[y] = sales.cust[y];
        metrics.ret[y] = sales.ret[y];
      }
      salesSource = "shopifyql";
    } catch (e) {
      shopifyqlError = e instanceof ShopifyError ? e.reason : "error";
    }

    try {
      const { rows } = await shopifyQL(cfg, buildSessionsQL(start, end));
      const sess = bucketSessions(rows, years);
      metrics.ses = sess.ses;
      metrics.conversion = sess.conversion;
      sessionsLive = true;
    } catch (e) {
      if (!shopifyqlError) shopifyqlError = e instanceof ShopifyError ? e.reason : "error";
    }

    // Orders FULFILLED (fulfillments dataset) — shown alongside orders placed. Best-effort:
    // if unavailable, `ordf` stays null and the front-end hides that card.
    try {
      const { rows } = await shopifyQL(cfg, buildFulfillmentsQL(start, end));
      metrics.ordf = bucketFulfillments(rows, years).ordf;
    } catch (e) {
      if (!shopifyqlError) shopifyqlError = e instanceof ShopifyError ? e.reason : "error";
    }

    res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=3600");
    return res.status(200).json({
      SG: metrics,
      meta: {
        live: true,
        asOf: new Date().toISOString(),
        range: { start, end },
        years,
        // months with data, keyed by year, so the front-end can label the window.
        monthsLive: Object.fromEntries(years.map((y) => [y, monthsWithData(metrics.ord[y])])),
        light,
        includeCustomer: light ? false : includeCustomer,
        orderCount: result.orders.length,
        truncated: result.truncated,
        // Where the live sales/sessions numbers came from, so the header can be honest.
        salesSource, // "shopifyql" (exact, matches admin) | "reconstructed" (Orders fallback)
        sessionsLive, // true when Sessions/Conversion are live from ShopifyQL
        ...(shopifyqlError ? { shopifyqlError } : {}),
      },
    });
  } catch (e) {
    const reason = e instanceof ShopifyError ? e.reason : "error";
    // Do not cache failures — a transient error shouldn't be pinned at the edge.
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      SG: {},
      meta: { live: false, reason, message: String(e?.message || e) },
    });
  }
}
