// lib/shopifyql.js
// Pure, dependency-free helpers that turn ShopifyQL (`shopifyqlQuery`) table rows into
// the dashboard's metric shape — the SAME `{ metric: { year: [12 months] } }` shape
// that lib/aggregate.js produces from the Orders API. ShopifyQL is the engine behind
// the admin Analytics page, so these figures (Gross Sales, Discounts, Orders, Sessions,
// Conversion) match the admin exactly, with no per-line reconstruction.
//
// Shared by the serverless API (api/dashboard.js) and the test suite (scripts/test.js).

import { emptyYear, round2, MONTHS } from "./aggregate.js";

// ── Query builders ───────────────────────────────────────────────────────────
// `TIMESERIES month` returns one row per calendar month of the window, with the
// month start labelled in the shop's timezone (e.g. "2026-01-01"). Months with no
// activity come back as 0 (not absent) — bucketShopifyQL treats those as "no data".
export function buildSalesQL(start, end) {
  // All from the `sales` dataset (one round trip). `quantity_ordered` = Shopify's
  // "items ordered" (gross, excludes cancelled). `customers` = distinct customers who
  // ordered; `returning_customers` = those with a prior order — new = customers − returning.
  return `FROM sales SHOW gross_sales, discounts, orders, quantity_ordered, customers, returning_customers TIMESERIES month SINCE ${start} UNTIL ${end}`;
}

export function buildSessionsQL(start, end) {
  return `FROM sessions SHOW sessions, conversion_rate TIMESERIES month SINCE ${start} UNTIL ${end}`;
}

// Column → dashboard-metric mappings. `presence` is the column that signals the month
// actually has data: if it is falsy/0 (e.g. future months, or a month with no orders),
// the whole month stays null so the front-end renders a blank — matching the Orders
// path's "no data" convention rather than a misleading 0.
export const SALES_SPEC = {
  presence: "orders",
  fields: [
    { col: "orders", metric: "ord" },
    { col: "gross_sales", metric: "rev", round: true },
    // ShopifyQL reports discounts as a NEGATIVE number; the dashboard wants a positive
    // magnitude (same as the Orders path's reconstructed `dis`).
    { col: "discounts", metric: "dis", abs: true, round: true },
    { col: "quantity_ordered", metric: "uni" },
    { col: "returning_customers", metric: "ret" },
    // `customers` = total distinct customers; bucketSales turns this into NEW customers
    // (cust) by subtracting returning, so it matches Shopify's first-time count exactly.
    { col: "customers", metric: "cust" },
  ],
};

export const SESSIONS_SPEC = {
  presence: "sessions",
  fields: [
    { col: "sessions", metric: "ses" },
    // conversion_rate is a fraction (0.0085 = 0.85%); stored as-is, formatted in the UI.
    { col: "conversion_rate", metric: "conversion" },
  ],
};

// Parse a number out of a ShopifyQL cell (values arrive as strings or numbers).
// Empty string / null / non-finite → null.
function toNum(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Year + 0-based month index from a "YYYY-MM-..." month label.
function parseMonth(label) {
  const m = /^(\d{4})-(\d{2})/.exec(String(label ?? ""));
  if (!m) return { year: null, month: null };
  return { year: Number(m[1]), month: Number(m[2]) - 1 };
}

// Bucket ShopifyQL rows into { metric: { year: [12 monthly values] } }.
// Months without data (presence column falsy) stay null; requested years are
// pre-seeded so a year with no rows still returns a full null array.
export function bucketShopifyQL(rows, { years, presence, fields } = {}) {
  if (!Array.isArray(years) || years.length === 0) {
    throw new Error("bucketShopifyQL requires a non-empty `years` array");
  }
  const out = {};
  for (const f of fields) {
    out[f.metric] = {};
    for (const y of years) out[f.metric][y] = emptyYear();
  }

  for (const row of Array.isArray(rows) ? rows : []) {
    const { year, month } = parseMonth(row?.month);
    if (year == null || month == null || month < 0 || month >= MONTHS) continue;
    if (!years.includes(year)) continue;
    if (!toNum(row?.[presence])) continue; // no data this month → leave null

    for (const f of fields) {
      let v = toNum(row?.[f.col]);
      if (v == null) continue;
      if (f.abs) v = Math.abs(v);
      if (f.round) v = round2(v);
      out[f.metric][year][month] = v;
    }
  }
  return out;
}

// Convenience wrappers used by api/dashboard.js.
// bucketSales also converts the `customers` total into NEW customers: cust = customers −
// returning (Shopify's first-time count). Done after bucketing so both land in the same
// month buckets; only months that have orders carry values (others stay null).
export function bucketSales(rows, years) {
  const out = bucketShopifyQL(rows, { years, ...SALES_SPEC });
  for (const y of years) {
    const total = out.cust[y]; // currently the `customers` total
    const ret = out.ret[y];
    out.cust[y] = total.map((t, i) =>
      t == null ? null : Math.max(0, t - (ret[i] || 0)),
    );
  }
  return out;
}

export function bucketSessions(rows, years) {
  return bucketShopifyQL(rows, { years, ...SESSIONS_SPEC });
}
