// api/dashboard.js
// Vercel serverless endpoint. Pulls live iORA SG orders from Shopify, aggregates
// them into the dashboard's metric shape, and returns JSON the front-end overlays
// onto its baseline data. Never exposes the token to the browser.
//
// Success  -> { SG: {rev,ord,uni,dis,vou,cust,ret}, meta:{ live:true, ... } }  (CDN-cached)
// Failure  -> { SG: {}, meta:{ live:false, reason } }                          (not cached)

import { getConfig, fetchOrders, ShopifyError } from "./_shopify.js";
import { bucketOrders, monthsWithData } from "../lib/aggregate.js";

// The dashboard's "live" year. Bump this each January (or derive from the shop date).
const LIVE_YEAR = 2026;
const SHOP_TZ = "Asia/Singapore";

export default async function handler(req, res) {
  const cfg = getConfig();

  try {
    const start = `${LIVE_YEAR}-01-01`;
    const end = `${LIVE_YEAR}-12-31`;

    // Try with customer data (for new vs returning). If the app lacks protected-
    // customer-data approval, retry without it so the other metrics still load.
    let includeCustomer = true;
    let result;
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

    const metrics = bucketOrders(result.orders, { years: [LIVE_YEAR], timeZone: SHOP_TZ });

    res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=3600");
    return res.status(200).json({
      SG: metrics,
      meta: {
        live: true,
        asOf: new Date().toISOString(),
        year: LIVE_YEAR,
        monthsLive: monthsWithData(metrics.ord[LIVE_YEAR]),
        includeCustomer,
        orderCount: result.orders.length,
        truncated: result.truncated,
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
