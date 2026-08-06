// api/marketplace.js
// Vercel serverless endpoint behind the Channel Mix panel and the marketplace rows of
// the Voucher Performance report — the two things Shopify provably cannot supply (every
// order in the Shopify stores has source_name "web"; marketplace sales never touch it).
//
// Query params:
//   ?brand=SG&start=YYYY-MM-DD&end=YYYY-MM-DD   (defaults to the current year to date)
//
// Every response is HTTP 200. Shopee and Lazada are independent and best-effort: a
// failure nulls that channel with a reason in meta.channels.<key>, and an unconfigured
// marketplace is `not-configured` — an honest blank, like an unwired Shopify store.
//
// The one thing this endpoint will NOT do is serve a partially paged window: a marketplace
// pull that runs out of its time budget fails its channel outright, because half a month
// of orders understates a channel's revenue — a wrong number is worse than a missing one.

import { fetchShopeeOrders } from "../lib/shopee.js";
import { fetchLazadaOrders } from "../lib/lazada.js";
import {
  buildChannelSeries,
  buildChannelOrderCounts,
  buildMarketplaceVouchers,
  channelTotals,
} from "../lib/marketplace.js";
import { settledPool, failInfo, deadline } from "../lib/http.js";
import { normalizeBrand, currencyOf } from "../lib/env-keys.js";
import { tokenStoreKind } from "../lib/token-store.js";

const SHOP_TZ = "Asia/Singapore";
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

function todayInTZ(tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const SOURCES = [
  { channel: "Shopee", fetch: fetchShopeeOrders },
  { channel: "Lazada", fetch: fetchLazadaOrders },
];

export default async function handler(req, res) {
  const today = todayInTZ(SHOP_TZ);
  const q = req.query || {};
  const brand = normalizeBrand(q.brand);

  let start = isDate(q.start) ? q.start : `${today.slice(0, 4)}-01-01`;
  let end = isDate(q.end) ? q.end : today;
  if (start > end) [start, end] = [end, start];

  const years = [];
  for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) years.push(y);

  // 45s of the 60s ceiling, shared by both marketplaces (they run concurrently).
  const budget = deadline(45000);

  const results = await settledPool(
    SOURCES.map((s) => () => s.fetch(process.env, brand, { start, end, deadline: budget })),
    2,
  );

  const channels = {};
  const metaChannels = {};
  let vouchers = [];
  let anyVouchers = false;
  let live = false;

  SOURCES.forEach((s, i) => {
    const r = results[i];
    if (r.status !== "fulfilled") {
      channels[s.channel] = null;
      metaChannels[s.channel] = failInfo(r.reason);
      return;
    }
    const { orders, notes = [], vouchersAvailable } = r.value;
    channels[s.channel] = {
      revenue: buildChannelSeries(orders, { years }),
      orders: buildChannelOrderCounts(orders, { years }),
      totals: channelTotals(orders),
    };
    if (vouchersAvailable !== false) {
      const rows = buildMarketplaceVouchers(orders, { channel: s.channel });
      vouchers = vouchers.concat(rows);
      anyVouchers = true;
    }
    metaChannels[s.channel] = {
      ok: true,
      orders: orders.length,
      // Cancelled/unpaid orders are pulled but excluded from every figure — reported so
      // the difference from a raw seller-centre export is explainable.
      excluded: orders.filter((o) => o.cancelled).length,
      vouchers: vouchersAvailable === false ? null : true,
      notes,
    };
    live = true;
  });

  vouchers.sort((a, b) => b.sales - a.sales);

  const meta = {
    live,
    brand,
    asOf: new Date().toISOString(),
    range: { start, end },
    years,
    currency: currencyOf(brand),
    // Marketplace order value is not defined identically to Shopify Gross Sales; the
    // panel repeats this so nobody reconciles the two to the cent.
    basis:
      "Marketplace figures are the order value each marketplace reports (buyer-paid), " +
      "excluding cancelled and unpaid orders. Website figures are Shopify ShopifyQL gross sales.",
    // Shopee/Lazada refresh tokens rotate, so a deployment without a durable token store
    // will start failing once the seed token is spent. Surface which backend is in use.
    tokenStore: tokenStoreKind(process.env),
    channels: metaChannels,
  };

  if (!live) {
    const firstFail = SOURCES.map((s) => metaChannels[s.channel]).find((m) => m && m.ok === false);
    const allUnconfigured = SOURCES.every(
      (s) => metaChannels[s.channel]?.reason === "not-configured",
    );
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      channels,
      vouchers: null,
      meta: {
        ...meta,
        reason: allUnconfigured ? "not-configured" : firstFail?.reason || "no-data",
        message: firstFail?.message,
      },
    });
  }

  const transient = SOURCES.some((s) => {
    const m = metaChannels[s.channel];
    return m && m.ok === false && ["throttle", "timeout", "http", "error"].includes(m.reason);
  });
  res.setHeader(
    "Cache-Control",
    transient ? "no-store" : "public, s-maxage=600, stale-while-revalidate=1200",
  );
  return res.status(200).json({ channels, vouchers: anyVouchers ? vouchers : null, meta });
}
