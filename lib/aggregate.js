// lib/aggregate.js
// Pure, dependency-free helpers that turn raw Shopify orders into the dashboard's
// metric shape, and that reproduce the dashboard's aggregate math. Shared by the
// serverless API (api/) and the test suite (scripts/test.js) so the numbers that
// ship are exactly the numbers we test.

export const MONTHS = 12;

// Metrics we can derive from the Shopify Orders API, in the dashboard's vocabulary.
export const ORDER_METRICS = ["rev", "ord", "uni", "dis", "vou", "cust", "ret"];

export function emptyYear() {
  return Array(MONTHS).fill(null);
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Normalize one Shopify GraphQL order node into the scalar fields we bucket on.
// Tolerant of missing fields (e.g. when the customer block is omitted for scope reasons).
export function normalizeOrder(node) {
  const money = (set) => parseFloat(set?.shopMoney?.amount ?? "0") || 0;
  const amount = money(node?.currentTotalPriceSet) || money(node?.totalPriceSet);
  const discounts = money(node?.totalDiscountsSet);

  let units = 0;
  for (const e of node?.lineItems?.edges ?? []) {
    units += Number(e?.node?.quantity ?? 0) || 0;
  }

  const codes = node?.discountCodes;
  const usedCode = Array.isArray(codes) ? codes.length > 0 : Boolean(codes);

  const numOrders =
    node?.customer && node.customer.numberOfOrders != null
      ? Number(node.customer.numberOfOrders)
      : null;

  return { createdAt: node?.createdAt, amount, discounts, units, usedCode, numOrders };
}

// Resolve the calendar year + 0-based month index of an ISO timestamp in a given
// IANA timezone (the shop's timezone), so orders near midnight land in the right month.
export function monthIndexInTZ(iso, timeZone = "Asia/Singapore") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date(iso));
  const year = Number(parts.find((p) => p.type === "year").value);
  const month = Number(parts.find((p) => p.type === "month").value) - 1;
  return { year, month };
}

// Bucket normalized orders into { metric: { year: [12 monthly values] } }.
// Months with no orders stay `null` (matches the dashboard convention for
// "no data" so future / empty months render blank rather than as 0).
export function bucketOrders(orders, { years, timeZone = "Asia/Singapore" } = {}) {
  if (!Array.isArray(years) || years.length === 0) {
    throw new Error("bucketOrders requires a non-empty `years` array");
  }
  const out = {};
  for (const m of ORDER_METRICS) {
    out[m] = {};
    for (const y of years) out[m][y] = emptyYear();
  }

  const bump = (metric, year, mi, val) => {
    const arr = out[metric][year];
    if (!arr) return;
    arr[mi] = (arr[mi] || 0) + val;
  };

  for (const o of orders) {
    if (!o?.createdAt) continue;
    const { year, month } = monthIndexInTZ(o.createdAt, timeZone);
    if (!years.includes(year)) continue;
    bump("rev", year, month, o.amount);
    bump("ord", year, month, 1);
    bump("uni", year, month, o.units);
    bump("dis", year, month, o.discounts);
    bump("vou", year, month, o.usedCode ? 1 : 0);
    if (o.numOrders === 1) bump("cust", year, month, 1);
    else if (o.numOrders != null && o.numOrders > 1) bump("ret", year, month, 1);
  }

  // Round currency metrics to cents.
  for (const y of years) {
    out.rev[y] = out.rev[y].map((v) => (v == null ? null : round2(v)));
    out.dis[y] = out.dis[y].map((v) => (v == null ? null : round2(v)));
  }

  // A month that HAS orders but no new/returning customers should read 0, not
  // blank. Coerce null -> 0 only for months that actually received orders;
  // months with no orders at all stay fully null ("no data").
  for (const y of years) {
    for (let i = 0; i < MONTHS; i++) {
      if (out.ord[y][i] == null) continue;
      for (const m of ORDER_METRICS) {
        if (out[m][y][i] == null) out[m][y][i] = 0;
      }
    }
  }
  return out;
}

// Overwrite ONLY the non-null indices of `live` onto a copy of `base`.
// This preserves baseline (Excel) months the API doesn't return and keeps
// future months null — mirroring the original file's overlay pattern.
export function mergeYearArray(base, live) {
  const out = (base || emptyYear()).slice();
  if (Array.isArray(live)) {
    live.forEach((v, i) => {
      if (v != null) out[i] = v;
    });
  }
  return out;
}

// Reproduces the dashboard's `aggBrand` (index.html) so tests can assert that
// SGALL/MYALL/GROUP totals equal the sum of their member brands.
// `members` = [{ key, fx? }]; fx applies to currency metrics only (FX merge for GROUP).
export function computeAggregate(
  brands,
  members,
  metrics = ["rev", "ord", "uni", "dis", "ses", "cust", "ret"],
  years = [2024, 2025, 2026],
) {
  const out = {};
  for (const mt of metrics) {
    out[mt] = {};
    for (const y of years) {
      const a = emptyYear();
      for (const m of members) {
        const src = brands?.[m.key]?.[mt]?.[y];
        if (!src) continue;
        const fx = mt === "rev" || mt === "dis" ? m.fx || 1 : 1;
        src.forEach((v, i) => {
          if (v != null) a[i] = (a[i] || 0) + v * fx;
        });
      }
      out[mt][y] = a;
    }
  }
  return out;
}

// Indices (0-based months) that actually received order data for a year.
export function monthsWithData(ordArray) {
  if (!Array.isArray(ordArray)) return [];
  return ordArray.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
}
