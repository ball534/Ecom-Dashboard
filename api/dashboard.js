// api/dashboard.js
// Vercel serverless endpoint. Pulls live iORA SG orders from Shopify for a date
// range, aggregates them into the dashboard's metric shape, and returns JSON the
// front-end overlays onto its baseline. Never exposes the token to the browser.
//
// Query params (optional):
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD   — defaults to (current year)-01-01 .. today
//
// Success  -> { SG: {rev,ord,uni,dis,vou,cust,ret}, meta:{ live:true, range, years, ... } }
// Failure  -> { SG: {}, meta:{ live:false, reason } }                          (not cached)

import { getConfig, fetchOrders, ShopifyError } from "./_shopify.js";
import { bucketOrders, monthsWithData } from "../lib/aggregate.js";

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

  const years = [];
  for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) years.push(y);

  try {
    // Try with customer data (new vs returning). If the app lacks protected-
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

    const metrics = bucketOrders(result.orders, { years, timeZone: SHOP_TZ });

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
