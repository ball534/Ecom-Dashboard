// scripts/test.js
// Unit tests for the aggregation math — proves the numbers tally and make sense
// WITHOUT needing a live Shopify token. Run: npm test
//
// Uses Node's built-in assertions; zero dependencies.

import assert from "node:assert/strict";
import {
  normalizeOrder,
  bucketOrders,
  classifyNewReturning,
  monthIndexInTZ,
  mergeYearArray,
  computeAggregate,
  monthsWithData,
} from "../lib/aggregate.js";
import {
  buildSalesQL,
  buildSessionsQL,
  buildFulfillmentsQL,
  bucketSales,
  bucketSessions,
  bucketFulfillments,
} from "../lib/shopifyql.js";
import {
  SKU_PULL_LIMIT,
  buildSkuSalesQL,
  buildTitleSalesQL,
  buildDiscountCodesQL,
  buildReferrersQL,
  buildOrderReferrersQL,
  buildCampaignsQL,
  parseTopSkus,
  parseTopTitles,
  parseDiscountCodes,
  parseReferrers,
  parseOrderReferrers,
  parseCampaigns,
  categorizeSku,
  buildCategoryMix,
} from "../lib/insights.js";
import { CATEGORY_MAP } from "../lib/category-map.js";
import { TARGETS, validateTargets, getTargets } from "../lib/targets.js";
import { getConfig, envNames, resolveConfig } from "../api/_shopify.js";
import { clearTokenCache, getAppCredentials } from "../api/_token.js";
import { createHmac } from "node:crypto";
import {
  MONTHS_SHORT as ADS_MONTHS_SHORT,
  mondayOf,
  buildPlatformSeries,
  buildCampaignRows,
  resolveAdsYear,
} from "../lib/ads.js";
import { fetchMetaAds } from "../lib/ads-meta.js";
import { fetchGoogleAds } from "../lib/ads-google.js";
import { fetchTiktokAds } from "../lib/ads-tiktok.js";
import {
  buildChannelSeries,
  buildChannelOrderCounts,
  buildMarketplaceVouchers,
  channelTotals,
} from "../lib/marketplace.js";
import { fetchShopeeOrders, shopeeWindows, shopeeConfig, shopeeSignForTest } from "../lib/shopee.js";
import { fetchLazadaOrders, lazadaConfig, lazadaSignForTest } from "../lib/lazada.js";
import { ApiError, requestJSON, deadline, settledPool, failInfo } from "../lib/http.js";
import {
  envIdValue,
  envCredValue,
  storeSuffix,
  marketOf,
  currencyOf,
} from "../lib/env-keys.js";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- Raw Shopify-shaped order nodes (Singapore time) ----
// `amount` is the gross sales (it goes on the first line item, tax rate 0, so it
// passes through unchanged). `discounts` is attached as a discountAllocation on the
// first line item (tax rate 0 => no tax stripping) — matching how Shopify's Analytics
// "Discounts" is reconstructed. gateways drives voucher; custId + numOrders drive
// new-vs-returning (lifetime count == in-window count => first order is here).
const node = (createdAt, amount, discounts, qtys, gateways, numOrders, custId) => ({
  createdAt,
  paymentGatewayNames: gateways,
  lineItems: {
    edges: qtys.map((q, i) => ({
      node: {
        quantity: q,
        originalTotalSet: { shopMoney: { amount: String(i === 0 ? amount : 0) } },
        taxLines: [],
        discountAllocations:
          i === 0 && discounts
            ? [{ allocatedAmountSet: { shopMoney: { amount: String(discounts) } } }]
            : [],
      },
    })),
  },
  customer: numOrders == null ? null : { id: custId, numberOfOrders: numOrders },
});

const RAW = [
  node("2026-01-15T03:00:00Z", 100, 10, [1, 1], ["gift_card"], 1, "A"), // Jan, new, voucher
  node("2026-01-20T09:00:00Z", 50.5, 0, [1], ["shopify_payments"], 3, "B"), // Jan, returning
  node("2026-02-10T02:00:00Z", 200, 20, [2, 2], ["gift_card"], 1, "C"), // Feb, new, voucher
  node("2026-02-28T16:30:00Z", 30, 0, [1], ["shopify_payments"], null), // 00:30 Mar 1 SGT -> March, guest
];

test("normalizeOrder extracts scalars correctly", () => {
  const n = normalizeOrder(RAW[0]);
  assert.equal(n.amount, 100);
  assert.equal(n.discounts, 10);
  assert.equal(n.units, 2);
  assert.equal(n.usedVoucher, true);
  assert.equal(n.numOrders, 1);
  assert.equal(n.customerId, "A");
  assert.equal(n.test, false);
  assert.equal(n.cancelled, false);
});

test("classifyNewReturning: first-ever order is new, later same-customer orders returning", () => {
  const orders = [
    // customer X: lifetime 2, both orders in-window -> Jan is new, Mar is returning
    { createdAt: "2026-01-10T03:00:00Z", customerId: "X", numOrders: 2 },
    { createdAt: "2026-03-10T03:00:00Z", customerId: "X", numOrders: 2 },
    // customer Y: lifetime 5 but only 1 order in-window -> existed before -> returning
    { createdAt: "2026-02-10T03:00:00Z", customerId: "Y", numOrders: 5 },
    // guest -> null
    { createdAt: "2026-02-11T03:00:00Z", customerId: null, numOrders: null },
  ];
  const c = classifyNewReturning(orders);
  assert.equal(c[0].isNew, true); // X's first ever
  assert.equal(c[1].isNew, false); // X again
  assert.equal(c[2].isNew, false); // Y pre-existed
  assert.equal(c[3].isNew, null); // guest
});

test("normalizeOrder counts GROSS units ordered (NOT net of refunds)", () => {
  const n = normalizeOrder({
    createdAt: "2026-04-10T03:00:00Z",
    lineItems: {
      edges: [
        { node: { quantity: 3, originalTotalSet: { shopMoney: { amount: "0" } }, taxLines: [] } },
        { node: { quantity: 2, originalTotalSet: { shopMoney: { amount: "0" } }, taxLines: [] } },
      ],
    },
  });
  assert.equal(n.units, 5); // matches Shopify's quantity_ordered (gross)
});

test("normalizeOrder reconstructs tax-excluded Gross Sales from tax-inclusive lines", () => {
  const n = normalizeOrder({
    createdAt: "2026-01-10T03:00:00Z",
    taxesIncluded: true,
    lineItems: {
      edges: [
        // $109 incl. 9% GST -> $100 gross; $54.5 incl. 9% -> $50
        { node: { quantity: 1, originalTotalSet: { shopMoney: { amount: "109" } }, taxLines: [{ rate: 0.09 }] } },
        { node: { quantity: 1, originalTotalSet: { shopMoney: { amount: "54.5" } }, taxLines: [{ rate: 0.09 }] } },
      ],
    },
  });
  assert.equal(Math.round(n.amount * 100) / 100, 150); // 100 + 50
});

test("normalizeOrder sums per-line discount allocations and strips embedded tax", () => {
  // Two lines, tax-inclusive at 9% GST. discountAllocations are tax-inclusive, so the
  // reconstructed (Shopify Analytics) discount strips the embedded tax per line.
  const n = normalizeOrder({
    createdAt: "2026-01-10T03:00:00Z",
    taxesIncluded: true,
    lineItems: {
      edges: [
        {
          node: {
            quantity: 1,
            originalTotalSet: { shopMoney: { amount: "109" } }, // $100 gross
            taxLines: [{ rate: 0.09 }],
            discountAllocations: [
              { allocatedAmountSet: { shopMoney: { amount: "10.9" } } }, // $10 pre-tax
            ],
          },
        },
        {
          node: {
            quantity: 1,
            originalTotalSet: { shopMoney: { amount: "54.5" } }, // $50 gross
            taxLines: [{ rate: 0.09 }],
            discountAllocations: [
              { allocatedAmountSet: { shopMoney: { amount: "5.45" } } }, // $5 pre-tax
            ],
          },
        },
      ],
    },
  });
  assert.equal(Math.round(n.amount * 100) / 100, 150); // 100 + 50 gross (tax-excluded)
  assert.equal(Math.round(n.discounts * 100) / 100, 15); // 10 + 5 discount (tax-excluded)
});

test("normalizeOrder flags test + cancelled orders", () => {
  const t = normalizeOrder({ createdAt: "2026-01-01T03:00:00Z", test: true });
  const c = normalizeOrder({ createdAt: "2026-01-01T03:00:00Z", cancelledAt: "2026-01-02T00:00:00Z" });
  assert.equal(t.test, true);
  assert.equal(c.cancelled, true);
});

test("monthIndexInTZ respects Asia/Singapore offset (month rollover)", () => {
  // 16:30 UTC on Feb 28 is 00:30 on Mar 1 in SGT (+8) -> March (index 2)
  assert.deepEqual(monthIndexInTZ("2026-02-28T16:30:00Z", "Asia/Singapore"), {
    year: 2026,
    month: 2,
  });
  assert.deepEqual(monthIndexInTZ("2026-01-15T03:00:00Z", "Asia/Singapore"), {
    year: 2026,
    month: 0,
  });
});

test("bucketOrders produces correct per-month metrics", () => {
  const orders = RAW.map(normalizeOrder);
  const m = bucketOrders(orders, { years: [2026], timeZone: "Asia/Singapore" });

  // January (index 0)
  assert.equal(m.rev[2026][0], 150.5);
  assert.equal(m.ord[2026][0], 2);
  assert.equal(m.uni[2026][0], 3);
  assert.equal(m.dis[2026][0], 10);
  assert.equal(m.vou[2026][0], 1);
  assert.equal(m.cust[2026][0], 1); // one new
  assert.equal(m.ret[2026][0], 1); // one returning

  // February (index 1)
  assert.equal(m.rev[2026][1], 200);
  assert.equal(m.ord[2026][1], 1);
  assert.equal(m.uni[2026][1], 4);
  assert.equal(m.vou[2026][1], 1);
  assert.equal(m.cust[2026][1], 1);
  assert.equal(m.ret[2026][1], 0);

  // March (index 2) — the timezone-rollover order, no customer block
  assert.equal(m.rev[2026][2], 30);
  assert.equal(m.ord[2026][2], 1);
  assert.equal(m.cust[2026][2], 0);
  assert.equal(m.ret[2026][2], 0);

  // Future / empty months stay null
  assert.equal(m.rev[2026][5], null);
  assert.equal(m.ord[2026][11], null);
});

test("totals tally: sum of monthly revenue == sum of order amounts", () => {
  const orders = RAW.map(normalizeOrder);
  const m = bucketOrders(orders, { years: [2026], timeZone: "Asia/Singapore" });
  const sum = (a) => a.reduce((t, v) => t + (v || 0), 0);

  const totalRev = sum(m.rev[2026]);
  const expectedRev = orders.reduce((t, o) => t + o.amount, 0);
  assert.equal(totalRev, expectedRev);
  assert.equal(totalRev, 380.5);

  assert.equal(sum(m.ord[2026]), orders.length); // 4
  assert.equal(sum(m.uni[2026]), orders.reduce((t, o) => t + o.units, 0)); // 8
  assert.equal(sum(m.cust[2026]) + sum(m.ret[2026]) <= sum(m.ord[2026]), true); // no more than orders
});

test("data makes sense: revenue is null exactly where there are no orders", () => {
  const orders = RAW.map(normalizeOrder);
  const m = bucketOrders(orders, { years: [2026], timeZone: "Asia/Singapore" });
  for (let i = 0; i < 12; i++) {
    const hasOrders = m.ord[2026][i] != null;
    const hasRev = m.rev[2026][i] != null;
    assert.equal(hasOrders, hasRev, `month ${i}: ord/rev presence must match`);
    if (hasOrders) {
      const aov = m.rev[2026][i] / m.ord[2026][i];
      assert.equal(aov > 0, true, `month ${i}: AOV must be positive`);
    }
  }
});

test("mergeYearArray overwrites only non-null live indices, preserving baseline", () => {
  const base = [10, 20, 30, 40, null, null, null, null, null, null, null, null];
  const live = [null, 999, null, 444, null, null, null, null, null, null, null, null];
  const merged = mergeYearArray(base, live);
  assert.deepEqual(merged, [10, 999, 30, 444, null, null, null, null, null, null, null, null]);
  // Original baseline array is not mutated
  assert.equal(base[1], 20);
});

test("computeAggregate sums member brands (and applies FX to currency metrics)", () => {
  const brands = {
    SG: { rev: { 2026: [100, 200, null] }, ord: { 2026: [2, 4, null] } },
    TRTSG: { rev: { 2026: [50, null, 10] }, ord: { 2026: [1, null, 1] } },
  };
  const agg = computeAggregate(
    brands,
    [{ key: "SG" }, { key: "TRTSG" }],
    ["rev", "ord"],
    [2026],
  );
  assert.deepEqual(agg.rev[2026].slice(0, 3), [150, 200, 10]);
  assert.deepEqual(agg.ord[2026].slice(0, 3), [3, 4, 1]);

  // FX applied to revenue only
  const aggFx = computeAggregate(
    brands,
    [{ key: "SG" }, { key: "TRTSG", fx: 0.3 }],
    ["rev", "ord"],
    [2026],
  );
  assert.equal(aggFx.rev[2026][0], 100 + 50 * 0.3); // 115
  assert.equal(aggFx.ord[2026][0], 3); // counts are NOT FX-scaled
});

test("monthsWithData lists only months that received orders", () => {
  const orders = RAW.map(normalizeOrder);
  const m = bucketOrders(orders, { years: [2026], timeZone: "Asia/Singapore" });
  assert.deepEqual(monthsWithData(m.ord[2026]), [0, 1, 2]);
});

// ---- ShopifyQL parsing (lib/shopifyql.js) ----

test("buildSalesQL / buildSessionsQL emit the expected ShopifyQL", () => {
  const s = buildSalesQL("2026-01-01", "2026-06-29");
  assert.ok(/^FROM sales SHOW gross_sales, discounts, orders/.test(s));
  assert.ok(s.includes("TIMESERIES month SINCE 2026-01-01 UNTIL 2026-06-29"));
  const v = buildSessionsQL("2026-01-01", "2026-06-29");
  assert.ok(/^FROM sessions SHOW sessions, conversion_rate/.test(v));
  assert.ok(v.includes("TIMESERIES month SINCE 2026-01-01 UNTIL 2026-06-29"));
});

test("bucketSales maps columns, flips discount sign, derives new customers, nulls empty months", () => {
  // Rows as shopifyqlQuery returns them: month label + string values. June has no
  // orders (a future/empty month in ShopifyQL comes back as 0) and must stay null.
  const rows = [
    { month: "2026-01-01", gross_sales: "109324.31", discounts: "-9841.47", orders: "1451",
      quantity_ordered: "4164", customers: "1282", returning_customers: "762" },
    { month: "2026-02-01", gross_sales: "83503.40", discounts: "-7505.62", orders: "1258",
      quantity_ordered: "3129", customers: "1143", returning_customers: "615" },
    { month: "2026-06-01", gross_sales: "0", discounts: "0", orders: "0",
      quantity_ordered: "0", customers: "0", returning_customers: "0" },
  ];
  const m = bucketSales(rows, [2026]);
  assert.equal(m.rev[2026][0], 109324.31);
  assert.equal(m.dis[2026][0], 9841.47); // sign flipped to a positive magnitude
  assert.equal(m.ord[2026][0], 1451);
  assert.equal(m.uni[2026][0], 4164);
  assert.equal(m.ret[2026][0], 762);
  assert.equal(m.cust[2026][0], 1282 - 762); // NEW = customers − returning = 520
  assert.equal(m.cust[2026][1], 1143 - 615); // 528
  assert.equal(m.rev[2026][1], 83503.4);
  assert.equal(m.ord[2026][5], null); // orders:0 -> no data -> blank
  assert.equal(m.rev[2026][5], null);
  assert.equal(m.uni[2026][5], null);
  assert.equal(m.cust[2026][5], null);
  assert.equal(m.ret[2026][5], null);
  assert.equal(m.rev[2026][2], null); // March absent from rows -> blank
});

test("buildFulfillmentsQL emits the expected ShopifyQL and bucketFulfillments maps orders_fulfilled", () => {
  const q = buildFulfillmentsQL("2026-01-01", "2026-06-29");
  assert.ok(/^FROM fulfillments SHOW orders_fulfilled/.test(q));
  assert.ok(q.includes("TIMESERIES month SINCE 2026-01-01 UNTIL 2026-06-29"));
  const rows = [
    { month: "2026-01-01", orders_fulfilled: "1422" },
    { month: "2026-07-01", orders_fulfilled: "0" }, // no fulfilments -> blank
  ];
  const m = bucketFulfillments(rows, [2026]);
  assert.equal(m.ordf[2026][0], 1422);
  assert.equal(m.ordf[2026][6], null);
});

test("bucketSessions maps sessions + conversion_rate and keeps the rate as a fraction", () => {
  const rows = [
    { month: "2026-01-01", sessions: "167920", conversion_rate: "0.008504049547403525" },
    { month: "2026-07-01", sessions: "0", conversion_rate: "" },
  ];
  const m = bucketSessions(rows, [2026]);
  assert.equal(m.ses[2026][0], 167920);
  assert.equal(m.conversion[2026][0], 0.008504049547403525);
  assert.equal(m.ses[2026][6], null); // sessions:0 -> blank
  assert.equal(m.conversion[2026][6], null);
});

test("bucketSales splits a multi-year range and ignores out-of-range years", () => {
  const rows = [
    { month: "2025-12-01", gross_sales: "5000", discounts: "-100", orders: "80" },
    { month: "2026-01-01", gross_sales: "6000", discounts: "-200", orders: "90" },
    { month: "2027-01-01", gross_sales: "9999", discounts: "-9", orders: "9" },
  ];
  const m = bucketSales(rows, [2025, 2026]);
  assert.equal(m.rev[2025][11], 5000); // December 2025
  assert.equal(m.ord[2026][0], 90); // January 2026
  assert.ok(!(2027 in m.rev)); // year outside the requested set is dropped entirely
});

// ---- Insights builders + parsers (lib/insights.js) ----

test("insight builders emit the expected ShopifyQL", () => {
  const sku = buildSkuSalesQL("2026-06-01", "2026-06-30");
  assert.ok(/^FROM sales SHOW quantity_ordered, gross_sales, net_sales, orders GROUP BY product_variant_sku/.test(sku));
  assert.ok(sku.includes(`ORDER BY quantity_ordered DESC LIMIT ${SKU_PULL_LIMIT} SINCE 2026-06-01 UNTIL 2026-06-30`));
  const title = buildTitleSalesQL("2026-06-01", "2026-06-30", 10);
  assert.ok(/GROUP BY product_title ORDER BY quantity_ordered DESC LIMIT 10/.test(title));
  assert.ok(/^FROM sales SHOW discounts, orders, gross_sales GROUP BY discount_code SINCE 2026-06-01 UNTIL 2026-06-30$/.test(buildDiscountCodesQL("2026-06-01", "2026-06-30")));
  assert.ok(/^FROM sessions SHOW sessions GROUP BY referrer_source SINCE /.test(buildReferrersQL("2026-06-01", "2026-06-30")));
  assert.ok(/^FROM sales SHOW orders, total_sales GROUP BY order_referrer_source SINCE /.test(buildOrderReferrersQL("2026-06-01", "2026-06-30")));
  assert.ok(/^FROM sessions SHOW sessions GROUP BY utm_campaign SINCE /.test(buildCampaignsQL("2026-06-01", "2026-06-30")));
});

test("parseTopSkus parses strings, rounds money, drops null skus, respects limit", () => {
  const rows = [
    { product_variant_sku: "AFBS0001-BLK-M", quantity_ordered: "14", gross_sales: "133.026", net_sales: "133.02" },
    { product_variant_sku: null, quantity_ordered: "99", gross_sales: "999", net_sales: "999" },
    { product_variant_sku: "BFDQ0002-TGN-M", quantity_ordered: "12", gross_sales: "110.1", net_sales: "110.1" },
    { product_variant_sku: "AFSK0003-BLK-M", quantity_ordered: "20", gross_sales: "91.744", net_sales: "91.74" },
  ];
  const top = parseTopSkus(rows, 2);
  assert.equal(top.length, 2);
  assert.equal(top[0].sku, "AFSK0003-BLK-M"); // sorted by qty desc, null sku dropped
  assert.equal(top[1].sku, "AFBS0001-BLK-M");
  assert.equal(top[1].gross, 133.03); // round2
  assert.equal(top[0].qty, 20);
  const titles = parseTopTitles([{ product_title: "Knit Top", quantity_ordered: "91", gross_sales: "1726.72", net_sales: "1700", orders: "38" }], 5);
  assert.deepEqual(titles, [{ title: "Knit Top", qty: 91, gross: 1726.72, net: 1700, orders: 38 }]);
});

test("parseDiscountCodes: null code → noCode, discounts flipped positive, sorted, tail folds into others", () => {
  const rows = [
    { discount_code: null, discounts: "0", orders: "900", gross_sales: "66000" },
    { discount_code: "SMALL", discounts: "-10.005", orders: "2", gross_sales: "100" },
    { discount_code: "JUNSAVE15", discounts: "-1361.49", orders: "99", gross_sales: "9007.12" },
    { discount_code: "MID", discounts: "-300", orders: "30", gross_sales: "2000" },
    { discount_code: "TINY", discounts: "-5", orders: "1", gross_sales: "40" },
  ];
  const d = parseDiscountCodes(rows, 2);
  assert.deepEqual(d.noCode, { orders: 900, gross: 66000, discount: 0 });
  assert.equal(d.codes.length, 2);
  assert.equal(d.codes[0].code, "JUNSAVE15"); // sorted by discount desc
  assert.equal(d.codes[0].discount, 1361.49); // positive magnitude
  assert.equal(d.codes[1].code, "MID");
  assert.deepEqual(d.others, { count: 2, orders: 3, gross: 140, discount: 15.01 }); // SMALL + TINY
  // No overflow -> others is null
  assert.equal(parseDiscountCodes(rows, 50).others, null);
});

test("traffic parsers: sort desc, preserve null referrer, drop null campaigns, respect limit", () => {
  const refs = parseReferrers([
    { referrer_source: "social", sessions: "24842" },
    { referrer_source: "direct", sessions: "50657" },
    { referrer_source: null, sessions: "5801" },
  ]);
  assert.equal(refs[0].source, "direct");
  assert.equal(refs[2].source, null); // preserved
  const ords = parseOrderReferrers([
    { order_referrer_source: "search", orders: "391", total_sales: "26320.379" },
    { order_referrer_source: null, orders: "808", total_sales: "53755.14" },
  ]);
  assert.equal(ords[0].source, null); // sorted by orders desc, null preserved
  assert.equal(ords[1].sales, 26320.38); // round2
  const camps = parseCampaigns([
    { utm_campaign: null, sessions: "69087" },
    { utm_campaign: "B", sessions: "1413" },
    { utm_campaign: "A", sessions: "15079" },
    { utm_campaign: "", sessions: "22" },
  ], 1);
  assert.deepEqual(camps, [{ campaign: "A", sessions: 15079 }]); // nulls dropped, limit applied
});

test("categorizeSku: longest prefix wins, case-insensitive, override beats prefix, unknown/null → fallback", () => {
  const map = {
    prefixes: { AFB: "Generic A", AFBS: "Blouses" },
    overrides: { "afbs0001-blk-m": "Special" },
    fallback: "Other",
  };
  assert.equal(categorizeSku("AFBS0002", map), "Blouses"); // longest prefix wins over AFB
  assert.equal(categorizeSku("AFBX0002", map), "Generic A"); // falls back to shorter prefix
  assert.equal(categorizeSku("afbs0002", map), "Blouses"); // case-insensitive
  assert.equal(categorizeSku("AFBS0001-BLK-M", map), "Special"); // override wins
  assert.equal(categorizeSku("ZZXX1234", map), "Other");
  assert.equal(categorizeSku(null, map), "Other");
  assert.equal(categorizeSku("", map), "Other");
});

test("buildCategoryMix aggregates, shares sum to 1, unmapped prefixes reported", () => {
  const map = { prefixes: { AFBS: "Blouses" }, overrides: {}, fallback: "Other" };
  const rows = [
    { product_variant_sku: "AFBS0001", quantity_ordered: "10", gross_sales: "100" },
    { product_variant_sku: "AFBS0002", quantity_ordered: "5", gross_sales: "50" },
    { product_variant_sku: "ZZXX9999", quantity_ordered: "2", gross_sales: "50" },
  ];
  const mix = buildCategoryMix(rows, map);
  assert.equal(mix.rows[0].category, "Blouses");
  assert.equal(mix.rows[0].gross, 150);
  assert.equal(mix.rows[0].qty, 15);
  assert.equal(mix.rows[0].share, 0.75);
  assert.equal(mix.rows[1].category, "Other");
  assert.equal(mix.rows[1].share, 0.25);
  const shareSum = mix.rows.reduce((t, r) => t + r.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9);
  assert.equal(mix.unmapped.length, 1);
  assert.equal(mix.unmapped[0].prefix, "ZZXX");
  assert.equal(mix.unmapped[0].gross, 50);
  assert.equal(mix.truncated, false);
});

// ---- Targets (lib/targets.js) ----

test("validateTargets rejects malformed data with precise messages", () => {
  assert.throws(() => validateTargets(null), /must be an object/);
  assert.throws(() => validateTargets({ SG: { 26: Array(12).fill(null) } }), /4-digit year/);
  assert.throws(() => validateTargets({ SG: { 2026: Array(11).fill(null) } }), /exactly 12/);
  assert.throws(() => validateTargets({ SG: { 2026: [...Array(11).fill(null), "1000"] } }), /non-negative number/);
  assert.throws(() => validateTargets({ SG: { 2026: [...Array(11).fill(null), -5] } }), /non-negative number/);
  assert.equal(validateTargets({ SG: { 2026: [150000, ...Array(11).fill(null)] } }), true);
});

test("getTargets returns {year:[12]} copies for requested years only; null when absent", () => {
  const data = { SG: { 2025: Array(12).fill(1000), 2026: [2000, ...Array(11).fill(null)] } };
  assert.equal(getTargets(data, "MY", [2026]), null); // brand absent
  assert.equal(getTargets(data, "SG", [2024]), null); // no matching year
  const got = getTargets(data, "SG", [2025, 2026]);
  assert.deepEqual(Object.keys(got), ["2025", "2026"]);
  got[2025][0] = 9;
  assert.equal(data.SG[2025][0], 1000); // copies, not references
});

test("the real checked-in CATEGORY_MAP and TARGETS pass validation", () => {
  assert.equal(validateTargets(TARGETS), true);
  assert.equal(typeof CATEGORY_MAP.fallback, "string");
  assert.ok(CATEGORY_MAP.fallback.length > 0);
  const seen = new Set();
  for (const [prefix, cat] of Object.entries(CATEGORY_MAP.prefixes)) {
    assert.ok(typeof cat === "string" && cat.length > 0, `prefix ${prefix} has an empty category`);
    const up = prefix.toUpperCase();
    assert.ok(!seen.has(up), `case-duplicate prefix key: ${prefix}`);
    seen.add(up);
  }
});

// ---- store credentials (getConfig) ----

test("getConfig reads TOKEN_/DOMAIN_ per store, maps SG/MY to the iORA suffixes", () => {
  const env = {
    TOKEN_IORASG: "shpat_" + "a".repeat(32),
    DOMAIN_IORASG: "iora-sg.myshopify.com",
    TOKEN_MONOMY: "shpat_" + "b".repeat(32),
    DOMAIN_MONOMY: "https://monoloq-my.myshopify.com/admin",
  };
  assert.deepEqual(envNames("SG"), { token: "TOKEN_IORASG", domain: "DOMAIN_IORASG" });
  assert.deepEqual(envNames("MY"), { token: "TOKEN_IORAMY", domain: "DOMAIN_IORAMY" });
  assert.deepEqual(envNames("TRTSG"), { token: "TOKEN_TRTSG", domain: "DOMAIN_TRTSG" });

  const sg = getConfig(env, "SG");
  assert.equal(sg.token, env.TOKEN_IORASG);
  assert.equal(sg.domain, "iora-sg.myshopify.com");

  // Scheme + path are stripped from the domain.
  assert.equal(getConfig(env, "MONOMY").domain, "monoloq-my.myshopify.com");

  // A store with no pair set stays empty, so the API reports "not-configured".
  const blank = getConfig(env, "TRTSG");
  assert.equal(blank.token, "");
  assert.equal(blank.domain, "");
});

test("getConfig corrects a transposed TOKEN_/DOMAIN_ pair instead of failing as a network error", () => {
  const token = "shpat_" + "c".repeat(32);
  // The pair entered the wrong way round — the mistake that blanked the dashboard.
  const env = { TOKEN_IORASG: "iora-sg.myshopify.com", DOMAIN_IORASG: token };
  const warn = console.warn;
  console.warn = () => {}; // the fix logs once; keep the test output clean
  try {
    const cfg = getConfig(env, "SG");
    assert.equal(cfg.token, token);
    assert.equal(cfg.domain, "iora-sg.myshopify.com");
  } finally {
    console.warn = warn;
  }

  // Only an unambiguous transposition is corrected: one bad value alone is left as-is.
  const half = getConfig({ TOKEN_IORASG: "iora-sg.myshopify.com", DOMAIN_IORASG: "" }, "SG");
  assert.equal(half.token, "iora-sg.myshopify.com");
  assert.equal(half.domain, "");
});

// ---- minted tokens (resolveConfig + api/_token.js) ----

// Stand in for the OAuth token endpoint. Returns a distinct token per call so the tests
// can tell a cache hit from a fresh mint.
function stubTokenEndpoint({ status = 200, expiresIn = 86399 } = {}) {
  const real = globalThis.fetch;
  const calls = [];
  let n = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body || "") });
    if (status !== 200) {
      return { ok: false, status, text: async () => "bad credentials" };
    }
    n += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: `shpat_minted_${n}`, expires_in: expiresIn }),
    };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("app credentials are read under both CLIENT_<S>/SECRET_<S> and <S>_CLIENT/<S>_SECRET", () => {
  assert.deepEqual(getAppCredentials({ CLIENT_TRTSG: "id-a", SECRET_TRTSG: "shpss_a" }, "TRTSG"), {
    clientId: "id-a",
    clientSecret: "shpss_a",
  });
  // The spelling oauth/main.py's .env used, so it can be pasted into Vercel unchanged.
  assert.deepEqual(getAppCredentials({ TRTSG_CLIENT: "id-b", TRTSG_SECRET: "shpss_b" }, "TRTSG"), {
    clientId: "id-b",
    clientSecret: "shpss_b",
  });
});

test("resolveConfig mints a token from CLIENT_/SECRET_ and caches it across calls", async () => {
  clearTokenCache();
  const stub = stubTokenEndpoint();
  try {
    const env = {
      DOMAIN_TRTSG: "trt-sg.myshopify.com",
      CLIENT_TRTSG: "client-id",
      SECRET_TRTSG: "shpss_secret",
    };
    const cfg = await resolveConfig(env, "TRTSG");
    assert.equal(cfg.token, "shpat_minted_1");
    assert.equal(cfg.minted, true);
    assert.ok(!cfg.tokenError);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, "https://trt-sg.myshopify.com/admin/oauth/access_token");
    assert.match(stub.calls[0].body, /grant_type=client_credentials/);

    // A second request in the same (warm) process reuses the cached token — no second mint.
    const again = await resolveConfig(env, "TRTSG");
    assert.equal(again.token, "shpat_minted_1");
    assert.equal(stub.calls.length, 1);

    // refresh() forces a new one, e.g. after Shopify rejects the cached token with a 401.
    await again.refresh();
    assert.equal(again.token, "shpat_minted_2");
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
    clearTokenCache();
  }
});

test("resolveConfig keeps a permanent TOKEN_ and never calls the token endpoint", async () => {
  clearTokenCache();
  const stub = stubTokenEndpoint();
  try {
    const cfg = await resolveConfig(
      {
        DOMAIN_IORASG: "iora-online.myshopify.com",
        TOKEN_IORASG: "shpat_" + "d".repeat(32),
        CLIENT_IORASG: "ignored",
        SECRET_IORASG: "ignored",
      },
      "SG",
    );
    assert.equal(cfg.token, "shpat_" + "d".repeat(32));
    assert.ok(!cfg.minted);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    clearTokenCache();
  }
});

test("a failed mint yields cfg.tokenError instead of throwing, and never claims a token", async () => {
  clearTokenCache();
  const stub = stubTokenEndpoint({ status: 401 });
  try {
    const cfg = await resolveConfig(
      { DOMAIN_MONOMY: "monoloq-my.myshopify.com", CLIENT_MONOMY: "bad", SECRET_MONOMY: "bad" },
      "MONOMY",
    );
    assert.equal(cfg.token, "");
    assert.equal(cfg.tokenError.reason, "auth");
    assert.match(cfg.tokenError.message, /monoloq-my\.myshopify\.com/);
  } finally {
    stub.restore();
    clearTokenCache();
  }
});

test("a store with neither a token nor app credentials stays unconfigured (no mint attempt)", async () => {
  clearTokenCache();
  const stub = stubTokenEndpoint();
  try {
    const cfg = await resolveConfig({ DOMAIN_SANSMY: "sansandsans-my.myshopify.com" }, "SANSMY");
    assert.equal(cfg.token, "");
    assert.ok(!cfg.tokenError);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    clearTokenCache();
  }
});

// ===========================================================================
// Phases 1–3 (ad platforms) + phase 6 (marketplaces): the pure layers. No
// network, no credentials — these prove the shapes the dashboard renders and,
// above all, that "the platform didn't report this" stays null instead of 0.
// ===========================================================================

test("env keys: identifiers are per store, credentials fall back store -> market -> bare", () => {
  const env = {
    META_AD_ACCOUNT_IORASG: "act_111",
    META_AD_ACCOUNT_MY: "act_222", // the plan's shorthand for iORA MY
    META_AD_ACCOUNT_TRTSG: "act_333",
    META_ACCESS_TOKEN: "shared",
    META_ACCESS_TOKEN_SG: "sg-token",
    META_ACCESS_TOKEN_MONOMY: "mono-token",
  };
  assert.equal(envIdValue(env, "META_AD_ACCOUNT", "SG"), "act_111");
  assert.equal(envIdValue(env, "META_AD_ACCOUNT", "MY"), "act_222");
  assert.equal(envIdValue(env, "META_AD_ACCOUNT", "TRTSG"), "act_333");
  // No market-level fallback for an identifier: SANS SG must NOT inherit iORA SG's
  // ad account, or one brand's spend would be reported as another's.
  assert.equal(envIdValue(env, "META_AD_ACCOUNT", "SANSSG"), "");
  // Credentials DO fall back: store -> market -> bare.
  assert.equal(envCredValue(env, "META_ACCESS_TOKEN", "MONOMY"), "mono-token");
  assert.equal(envCredValue(env, "META_ACCESS_TOKEN", "TRTSG"), "sg-token"); // market
  assert.equal(envCredValue(env, "META_ACCESS_TOKEN", "TRTMY"), "shared"); // bare
  assert.equal(storeSuffix("SG"), "IORASG");
  assert.equal(storeSuffix("MONOMY"), "MONOMY");
  assert.equal(marketOf("TRTMY"), "MY");
  assert.equal(currencyOf("TRTMY"), "MYR");
});

test("mondayOf snaps any day to its ISO week Monday", () => {
  assert.equal(mondayOf("2026-01-05"), "2026-01-05"); // a Monday
  assert.equal(mondayOf("2026-01-11"), "2026-01-05"); // the Sunday after it
  assert.equal(mondayOf("2026-01-12"), "2026-01-12");
  assert.equal(mondayOf("2026-03-01"), "2026-02-23"); // month + Sunday boundary
});

test("buildPlatformSeries rolls days into months + Mon–Sun weeks, keyed by real month index", () => {
  const rows = [
    { date: "2026-01-05", campaign: "A", spend: 100, impressions: 1000, clicks: 50, purchases: 2, revenue: 400 },
    { date: "2026-01-11", campaign: "A", spend: 50, impressions: 500, clicks: 25, purchases: 1, revenue: 200 },
    { date: "2026-01-12", campaign: "B", spend: 25, impressions: 250, clicks: 10, purchases: 0, revenue: 0 },
    { date: "2026-03-02", campaign: "A", spend: 10, impressions: 100, clicks: 5, purchases: 1, revenue: 90 },
  ];
  const s = buildPlatformSeries(rows, { year: 2026, supports: { purchases: true, revenue: true }, currency: "SGD" });
  // February has no rows: it is ABSENT, not zero.
  assert.deepEqual(s.months, ["Jan", "Mar"]);
  assert.deepEqual(s.monthIndexes, [0, 2]);
  assert.deepEqual(s.spend, [175, 10]);
  assert.deepEqual(s.impr, [1750, 100]);
  assert.deepEqual(s.purch, [3, 1]);
  assert.deepEqual(s.rev, [600, 90]);
  assert.equal(s.currency, "SGD");
  assert.equal(s.year, 2026);
  // Two weeks: 5–11 Jan (two rows) and 12–18 Jan, plus the March week.
  assert.deepEqual(s.weekly.map((w) => w.w), ["2026-01-05", "2026-01-12", "2026-03-02"]);
  assert.equal(s.weekly[0].spend, 150);
  assert.equal(s.weekly[1].spend, 25);
  // No budget is reported by any ad API, so the budget series and box stay null.
  assert.equal(s.budget, null);
  assert.equal(s.yearlyBudget, null);
});

test("buildPlatformSeries: an unreported metric is null for the whole series, never 0", () => {
  const rows = [
    { date: "2026-02-02", campaign: "A", spend: 10, impressions: 100, clicks: 5, purchases: 0, revenue: 0 },
  ];
  const s = buildPlatformSeries(rows, { year: 2026, supports: { purchases: false, revenue: false } });
  assert.equal(s.purch, null);
  assert.equal(s.rev, null);
  assert.equal(s.weekly[0].purch, null);
  assert.equal(s.weekly[0].rev, null);
  assert.deepEqual(s.spend, [10]); // spend is still real
});

test("buildPlatformSeries filters to the requested year and returns null when nothing lands", () => {
  const rows = [{ date: "2025-06-01", spend: 5, impressions: 1, clicks: 1, campaign: "A" }];
  assert.equal(buildPlatformSeries(rows, { year: 2026 }), null);
  assert.ok(buildPlatformSeries(rows, { year: 2025 }));
});

test("buildCampaignRows: one row per campaign, real first/last dates, null pu/rv preserved", () => {
  const rows = [
    { date: "2026-01-10", campaignId: "1", campaign: "Always On", spend: 100, impressions: 1000, clicks: 40, purchases: 2, revenue: 300 },
    { date: "2026-02-14", campaignId: "1", campaign: "Always On", spend: 200, impressions: 2000, clicks: 80, purchases: 4, revenue: 700 },
    { date: "2026-02-01", campaignId: "2", campaign: "Flash", spend: 400, impressions: 500, clicks: 20, purchases: 1, revenue: 100 },
  ];
  const out = buildCampaignRows(rows, { year: 2026, supports: { purchases: true, revenue: true } });
  assert.equal(out.length, 2);
  assert.equal(out[0].n, "Flash"); // sorted by spend desc
  const always = out.find((r) => r.n === "Always On");
  assert.equal(always.s, "2026-01-10");
  assert.equal(always.e, "2026-02-14");
  assert.equal(always.sp, 300);
  assert.equal(always.pu, 6);
  assert.equal(always.rv, 1000);
  assert.equal(always.g, null);

  const noConv = buildCampaignRows(rows, { year: 2026, supports: { purchases: false, revenue: false } });
  assert.equal(noConv[0].pu, null);
  assert.equal(noConv[0].rv, null);
});

test("resolveAdsYear clamps a multi-year range to its end year and says so", () => {
  assert.deepEqual(resolveAdsYear("2026-01-01", "2026-08-06"), {
    year: 2026, start: "2026-01-01", end: "2026-08-06", clamped: false,
  });
  assert.deepEqual(resolveAdsYear("2024-01-01", "2026-08-06"), {
    year: 2026, start: "2026-01-01", end: "2026-08-06", clamped: true,
  });
});

test("marketplace channel series: cancelled excluded, empty months null, not zero", () => {
  const orders = [
    { id: "1", date: "2026-01-05", total: 100, discount: 10, voucherCode: "A", cancelled: false },
    { id: "2", date: "2026-01-20", total: 50, discount: null, voucherCode: null, cancelled: false },
    { id: "3", date: "2026-02-01", total: 999, discount: 0, voucherCode: "A", cancelled: true }, // cancelled
    { id: "4", date: "2026-03-03", total: 25.5, discount: 5, voucherCode: "B", cancelled: false },
  ];
  const s = buildChannelSeries(orders, { years: [2026] });
  assert.equal(s[2026][0], 150);
  assert.equal(s[2026][1], null, "a month whose only order was cancelled must be null, not 0");
  assert.equal(s[2026][2], 25.5);
  assert.equal(s[2026][11], null);
  const counts = buildChannelOrderCounts(orders, { years: [2026] });
  assert.equal(counts[2026][0], 2);
  assert.equal(counts[2026][1], null);
  const t = channelTotals(orders);
  assert.equal(t.actual, 175.5);
  assert.equal(t.orders, 3);
  assert.equal(t.aov, 58.5);
  // A year outside the request is not emitted.
  assert.equal(buildChannelSeries(orders, { years: [2025] }), null);
});

test("marketplace voucher rows match the website report's contract, with unknown = null", () => {
  const orders = [
    { id: "1", date: "2026-01-05", total: 100, discount: 10, voucherCode: "SHOP10", cancelled: false },
    { id: "2", date: "2026-03-20", total: 300, discount: 30, voucherCode: "SHOP10", cancelled: false },
    { id: "3", date: "2026-02-02", total: 80, discount: null, voucherCode: "NODISC", cancelled: false },
    { id: "4", date: "2026-02-02", total: 500, discount: 50, voucherCode: "SHOP10", cancelled: true },
    { id: "5", date: "2026-02-02", total: 70, discount: 7, voucherCode: null, cancelled: false },
  ];
  const rows = buildMarketplaceVouchers(orders, { channel: "Shopee" });
  assert.equal(rows.length, 2, "orders without a voucher code are not voucher rows");
  const shop = rows.find((r) => r.title === "SHOP10");
  assert.equal(shop.ch, "Shopee");
  assert.equal(shop.sales, 400, "the cancelled order must not count");
  assert.equal(shop.redeemed, 2);
  assert.equal(shop.aov, 200);
  assert.equal(shop.disc, 40);
  assert.equal(shop.discPct, 9.09);
  assert.equal(shop.date, "Jan – Mar");
  assert.equal(shop.sent, null, "marketplaces do not report how many vouchers were issued");
  assert.equal(shop.rate, null);
  const nod = rows.find((r) => r.title === "NODISC");
  assert.equal(nod.disc, null, "an unreported discount must stay null, never 0");
  assert.equal(nod.discPct, null);
  assert.equal(nod.date, "Feb");
});

test("shopeeWindows tiles a range into ≤15-day epoch windows covering every day", () => {
  const w = shopeeWindows("2026-01-01", "2026-02-05");
  assert.equal(w.length, 3);
  // Contiguous and non-overlapping: each window starts the second after the last ended.
  for (let i = 1; i < w.length; i++) {
    assert.equal(w[i].time_from, w[i - 1].time_to + 1);
  }
  const day = 86400;
  assert.ok(w[0].time_to - w[0].time_from < 15 * day, "window longer than Shopee's 15-day cap");
  // First window starts at 00:00:00 SGT on the start date, last ends 23:59:59 on the end date.
  assert.equal(new Date(w[0].time_from * 1000).toISOString(), "2025-12-31T16:00:00.000Z");
  assert.equal(new Date(w[w.length - 1].time_to * 1000).toISOString(), "2026-02-05T15:59:59.000Z");
});

test("lazada signing: sorted key+value over the api path, HMAC-SHA256, upper hex", () => {
  const cfg = lazadaConfig(
    { LAZADA_APP_KEY: "key123", LAZADA_APP_SECRET: "secret456", LAZADA_ACCESS_TOKEN_SG: "tok" },
    "SG",
  );
  assert.equal(cfg.host, "https://api.lazada.sg/rest");
  assert.equal(cfg.appKey, "key123");
  const params = { app_key: "key123", timestamp: "1700000000000", sign_method: "sha256", offset: 0 };
  const got = lazadaSignForTest(cfg, "/orders/get", params);
  const expected = createHmac("sha256", "secret456")
    .update("/orders/getapp_keykey123offset0sign_methodsha256timestamp1700000000000")
    .digest("hex")
    .toUpperCase();
  assert.equal(got, expected);
  // A MY store resolves to the Malaysian host.
  const my = lazadaConfig({ LAZADA_APP_KEY: "k", LAZADA_APP_SECRET: "s" }, "MONOMY");
  assert.equal(my.host, "https://api.lazada.com.my/rest");
});

test("shopee signing: partner + path + timestamp (+ token + shop) keyed with the partner key", () => {
  const cfg = shopeeConfig(
    { SHOPEE_PARTNER_ID: "2000", SHOPEE_PARTNER_KEY: "pkey", SHOPEE_SHOP_ID_SG: "555" },
    "SG",
  );
  assert.equal(cfg.shopId, "555");
  const shopSign = shopeeSignForTest(cfg, "/api/v2/order/get_order_list", 1700000000, {
    accessToken: "atok",
    shopId: "555",
  });
  assert.equal(
    shopSign,
    createHmac("sha256", "pkey")
      .update("2000/api/v2/order/get_order_list1700000000atok555")
      .digest("hex"),
  );
  // Public (token) endpoints sign without the token/shop suffix.
  const pubSign = shopeeSignForTest(cfg, "/api/v2/auth/access_token/get", 1700000000, {});
  assert.equal(
    pubSign,
    createHmac("sha256", "pkey").update("2000/api/v2/auth/access_token/get1700000000").digest("hex"),
  );
});

test("requestJSON: 401 fails fast, 429 retries then reports throttle, timeouts are typed", async () => {
  const realFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "bad token" } }), { status: 401 });
    };
    await assert.rejects(
      () => requestJSON("https://x.test/a", { label: "T", retries: 3 }),
      (e) => e.reason === "auth" && /bad token/.test(e.message),
    );
    assert.equal(calls, 1, "an auth failure must not be retried");

    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("slow down", { status: 429 });
    };
    await assert.rejects(
      () => requestJSON("https://x.test/a", { label: "T", retries: 1 }),
      (e) => e.reason === "throttle",
    );
    assert.equal(calls, 2, "a throttle must be retried once when retries:1");

    // An API-level error inside a 200 body (TikTok/Lazada/Shopee style).
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 40105, message: "token" }), { status: 200 });
    await assert.rejects(
      () =>
        requestJSON("https://x.test/a", {
          label: "T",
          retries: 0,
          accept: (j) => {
            if (j.code) throw new ApiError("auth", j.message);
          },
        }),
      (e) => e.reason === "auth",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("deadline throws a typed timeout so a paged pull fails instead of half-reporting", () => {
  const d = deadline(0);
  assert.throws(() => d.check("Shopee order list"), (e) => e.reason === "timeout");
  const d2 = deadline(10000);
  assert.doesNotThrow(() => d2.check("x"));
  assert.ok(d2.remaining() > 0);
});

test("ad clients report an unconfigured brand as not-configured, naming the variables", async () => {
  await assert.rejects(
    () => fetchMetaAds({}, "TRTSG", { start: "2026-01-01", end: "2026-01-31" }),
    (e) => e.reason === "not-configured" && /META_AD_ACCOUNT_TRTSG/.test(e.message),
  );
  await assert.rejects(
    () => fetchGoogleAds({}, "SG", { start: "2026-01-01", end: "2026-01-31" }),
    (e) => e.reason === "not-configured" && /GOOGLE_ADS_DEVELOPER_TOKEN/.test(e.message),
  );
  await assert.rejects(
    () => fetchTiktokAds({}, "MY", { start: "2026-01-01", end: "2026-01-31" }),
    (e) => e.reason === "not-configured" && /TIKTOK_ADVERTISER_MY/.test(e.message),
  );
  await assert.rejects(
    () => fetchShopeeOrders({}, "SG", { start: "2026-01-01", end: "2026-01-31" }),
    (e) => e.reason === "not-configured" && /SHOPEE_PARTNER_ID/.test(e.message),
  );
  await assert.rejects(
    () => fetchLazadaOrders({}, "SG", { start: "2026-01-01", end: "2026-01-31" }),
    (e) => e.reason === "not-configured" && /LAZADA_APP_KEY/.test(e.message),
  );
});

test("Meta client maps a daily insights page into provider rows (stubbed HTTP)", async () => {
  const realFetch = globalThis.fetch;
  try {
    const seen = [];
    globalThis.fetch = async (url, opts) => {
      seen.push({ url: String(url), auth: opts?.headers?.Authorization });
      return new Response(
        JSON.stringify({
          data: [
            {
              date_start: "2026-01-05", date_stop: "2026-01-05",
              campaign_id: "9", campaign_name: "Always On",
              spend: "123.45", impressions: "10000", clicks: "400",
              account_currency: "SGD",
              actions: [
                { action_type: "landing_page_view", value: "300" },
                { action_type: "omni_purchase", value: "7" },
                { action_type: "purchase", value: "7" },
              ],
              action_values: [{ action_type: "omni_purchase", value: "980.50" }],
            },
          ],
        }),
        { status: 200 },
      );
    };
    const out = await fetchMetaAds(
      { META_ACCESS_TOKEN: "tok", META_AD_ACCOUNT_SG: "111" },
      "SG",
      { start: "2026-01-01", end: "2026-01-31" },
    );
    assert.equal(out.currency, "SGD");
    assert.deepEqual(out.supports, { purchases: true, revenue: true, budget: false });
    assert.equal(out.rows.length, 1);
    assert.deepEqual(out.rows[0], {
      date: "2026-01-05", campaignId: "9", campaign: "Always On",
      spend: 123.45, impressions: 10000, clicks: 400,
      // ONE purchase action is taken (omni first), never the sum of overlapping types.
      purchases: 7, revenue: 980.5,
    });
    assert.ok(/act_111\/insights/.test(seen[0].url), "bare account id must be normalized to act_<id>");
    assert.equal(seen[0].auth, "Bearer tok", "the token goes in the header, not the query string");
    assert.ok(!/access_token/.test(seen[0].url));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("TikTok client falls back to core metrics when the metric list is rejected, and says so", async () => {
  const realFetch = globalThis.fetch;
  try {
    let attempt = 0;
    globalThis.fetch = async (url) => {
      attempt++;
      const u = String(url);
      if (/complete_payment/.test(u)) {
        // First shape: TikTok rejects an unknown metric (HTTP 200, code != 0).
        return new Response(JSON.stringify({ code: 40002, message: "Invalid metric: complete_payment" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            list: [
              {
                dimensions: { campaign_id: "5", stat_time_day: "2026-01-05 00:00:00" },
                metrics: { campaign_name: "TT Always On", spend: "50.5", impressions: "9000", clicks: "300" },
              },
            ],
            page_info: { page: 1, total_page: 1 },
          },
        }),
        { status: 200 },
      );
    };
    const out = await fetchTiktokAds(
      { TIKTOK_ACCESS_TOKEN: "tok", TIKTOK_ADVERTISER_SG: "adv1" },
      "SG",
      { start: "2026-01-01", end: "2026-01-31" },
    );
    assert.equal(out.supports.purchases, false);
    assert.equal(out.supports.revenue, false);
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].date, "2026-01-05");
    assert.equal(out.rows[0].spend, 50.5);
    assert.equal(out.rows[0].purchases, null);
    assert.equal(out.rows[0].revenue, null);
    assert.ok(
      out.notes.some((n) => /retried with spend\/impressions\/clicks/.test(n)),
      "the fallback has to be stated in the notes the panel shows",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Lazada client maps /orders/get, excludes cancelled, keeps voucher codes", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const u = new URL(String(url));
      assert.ok(u.searchParams.get("sign"), "every Lazada call must be signed");
      assert.equal(u.searchParams.get("sign_method"), "sha256");
      return new Response(
        JSON.stringify({
          code: "0",
          data: {
            count: 2,
            orders: [
              { order_id: 1, created_at: "2026-01-05 12:00:00 +0800", price: "150.00", voucher: "15.00", voucher_code: "LAZ15", statuses: ["delivered"] },
              { order_id: 2, created_at: "2026-01-06 12:00:00 +0800", price: "80.00", statuses: ["canceled"] },
            ],
          },
        }),
        { status: 200 },
      );
    };
    const out = await fetchLazadaOrders(
      { LAZADA_APP_KEY: "k", LAZADA_APP_SECRET: "s", LAZADA_ACCESS_TOKEN_SG: "tok" },
      "SG",
      { start: "2026-01-01", end: "2026-01-31" },
    );
    assert.equal(out.orders.length, 2);
    assert.equal(out.orders[0].date, "2026-01-05");
    assert.equal(out.orders[0].total, 150);
    assert.equal(out.orders[0].voucherCode, "LAZ15");
    assert.equal(out.orders[0].cancelled, false);
    assert.equal(out.orders[1].cancelled, true);
    // The cancelled order contributes nothing downstream.
    assert.equal(buildChannelSeries(out.orders, { years: [2026] })[2026][0], 150);
  } finally {
    globalThis.fetch = realFetch;
  }
});


// ---- runner ----
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log(`  ✓ ${t.name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${t.name}`);
    console.error(`     ${e.message}`);
  }
}
console.log(`\n${passed}/${tests.length} passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
