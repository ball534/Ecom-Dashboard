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

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- Raw Shopify-shaped order nodes (Singapore time) ----
// gateways drives the voucher metric (gift_card/store_credit); custId + numOrders
// drive new-vs-returning (lifetime count == in-window count => first order is here).
const node = (createdAt, amount, discounts, qtys, gateways, numOrders, custId) => ({
  createdAt,
  currentTotalPriceSet: { shopMoney: { amount: String(amount) } },
  currentTotalDiscountsSet: { shopMoney: { amount: String(discounts) } },
  paymentGatewayNames: gateways,
  lineItems: { edges: qtys.map((q) => ({ node: { quantity: q } })) },
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

test("normalizeOrder counts NET units (ordered minus refunded)", () => {
  const n = normalizeOrder({
    createdAt: "2026-04-10T03:00:00Z",
    currentTotalPriceSet: { shopMoney: { amount: "100" } },
    lineItems: { edges: [{ node: { quantity: 3 } }, { node: { quantity: 2 } }] },
    refunds: [{ refundLineItems: { edges: [{ node: { quantity: 2 } }] } }],
  });
  assert.equal(n.units, 3); // 5 ordered − 2 refunded
});

test("normalizeOrder prefers CURRENT discount over original", () => {
  const n = normalizeOrder({
    createdAt: "2026-01-01T03:00:00Z",
    currentTotalPriceSet: { shopMoney: { amount: "90" } },
    totalDiscountsSet: { shopMoney: { amount: "20" } },
    currentTotalDiscountsSet: { shopMoney: { amount: "12" } }, // 8 of discount refunded
  });
  assert.equal(n.discounts, 12);
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
