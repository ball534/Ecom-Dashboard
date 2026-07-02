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

// ---- runner ----
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
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
