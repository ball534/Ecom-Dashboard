// lib/insights.js
// Pure, dependency-free helpers behind /api/insights: ShopifyQL query builders and
// row parsers for the "insight" sections — best sellers, discount-code performance,
// category mix (SKU-prefix mapping; product_type is mostly blank on these stores),
// and traffic attribution. Same conventions as lib/shopifyql.js: builders return
// query strings, parsers take the raw rows from shopifyQL() (objects keyed by column
// name, values arriving as strings or numbers) and return plain data.
//
// Shared by the serverless API (api/insights.js), the preview script
// (scripts/preview-insights.js) and the test suite (scripts/test.js).

import { round2 } from "./aggregate.js";

// Rows pulled for the SKU-level query — it feeds BOTH the best-sellers list and the
// whole category mix, so it needs to cover (nearly) all SKUs sold in the window.
// Verified live: the SG store sells ~9.6k distinct SKUs YTD and ShopifyQL accepts
// LIMIT 10000 (June 2026 alone was ~2.8k, so 1000 truncated badly).
export const SKU_PULL_LIMIT = 10000;
// Discount codes returned individually before folding the tail into `others`.
export const CODE_CAP = 50;
// How many unmapped SKU prefixes to report (so the team knows what to add to the map).
export const UNMAPPED_TOP = 10;
// Characters of SKU used when reporting unmapped prefixes.
export const PREFIX_LEN = 4;

// ── Query builders ───────────────────────────────────────────────────────────
// ORDER BY / LIMIT are only used where verified against the live store (the two
// product queries). The grouped session/discount queries are sorted in the parsers.
export function buildSkuSalesQL(start, end, limit = SKU_PULL_LIMIT) {
  return `FROM sales SHOW quantity_ordered, gross_sales, net_sales, orders GROUP BY product_variant_sku ORDER BY quantity_ordered DESC LIMIT ${limit} SINCE ${start} UNTIL ${end}`;
}

export function buildTitleSalesQL(start, end, limit) {
  return `FROM sales SHOW quantity_ordered, gross_sales, net_sales, orders GROUP BY product_title ORDER BY quantity_ordered DESC LIMIT ${limit} SINCE ${start} UNTIL ${end}`;
}

export function buildDiscountCodesQL(start, end) {
  return `FROM sales SHOW discounts, orders, gross_sales GROUP BY discount_code SINCE ${start} UNTIL ${end}`;
}

export function buildReferrersQL(start, end) {
  return `FROM sessions SHOW sessions GROUP BY referrer_source SINCE ${start} UNTIL ${end}`;
}

export function buildOrderReferrersQL(start, end) {
  return `FROM sales SHOW orders, total_sales GROUP BY order_referrer_source SINCE ${start} UNTIL ${end}`;
}

export function buildCampaignsQL(start, end) {
  return `FROM sessions SHOW sessions GROUP BY utm_campaign SINCE ${start} UNTIL ${end}`;
}

// One spec per underlying ShopifyQL call, so the handler and the preview script can
// fire/label them identically. `skuSales` feeds bestSellers.bySku AND categories.
export const INSIGHT_QUERIES = [
  { key: "skuSales", build: (s, e) => buildSkuSalesQL(s, e) },
  { key: "titleSales", build: (s, e, l) => buildTitleSalesQL(s, e, l) },
  { key: "discountCodes", build: (s, e) => buildDiscountCodesQL(s, e) },
  { key: "referrers", build: (s, e) => buildReferrersQL(s, e) },
  { key: "orderReferrers", build: (s, e) => buildOrderReferrersQL(s, e) },
  { key: "campaigns", build: (s, e) => buildCampaignsQL(s, e) },
];

// ── Cell helpers (same tolerant parsing as lib/shopifyql.js) ─────────────────
function toNum(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
const num = (v) => toNum(v) ?? 0;
// A grouped key cell that is null/"" means "no value" (e.g. no discount code).
function keyOf(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// ── Best sellers ─────────────────────────────────────────────────────────────
function parseProductRows(rows, keyCol, outKey, limit) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const k = keyOf(row?.[keyCol]);
    if (k == null) continue; // rows without a SKU/title can't be ranked
    out.push({
      [outKey]: k,
      qty: num(row?.quantity_ordered),
      gross: round2(num(row?.gross_sales)),
      net: round2(num(row?.net_sales)),
      orders: num(row?.orders),
    });
  }
  out.sort((a, b) => b.qty - a.qty);
  return out.slice(0, limit);
}

export function parseTopSkus(rows, limit) {
  return parseProductRows(rows, "product_variant_sku", "sku", limit);
}

export function parseTopTitles(rows, limit) {
  return parseProductRows(rows, "product_title", "title", limit);
}

// ── Discount codes ───────────────────────────────────────────────────────────
// ShopifyQL reports `discounts` as a NEGATIVE money amount; the dashboard wants a
// positive "amount given away". The null-code group (orders without a discount code)
// becomes `noCode`; codes beyond `cap` fold into an aggregate `others`.
export function parseDiscountCodes(rows, cap = CODE_CAP) {
  let noCode = null;
  const codes = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const rec = {
      orders: num(row?.orders),
      gross: round2(num(row?.gross_sales)),
      discount: round2(Math.abs(num(row?.discounts))),
    };
    const code = keyOf(row?.discount_code);
    if (code == null) noCode = rec;
    else codes.push({ code, ...rec });
  }
  codes.sort((a, b) => b.discount - a.discount);
  let others = null;
  if (codes.length > cap) {
    const tail = codes.splice(cap);
    others = tail.reduce(
      (t, c) => ({
        count: t.count + 1,
        orders: t.orders + c.orders,
        gross: round2(t.gross + c.gross),
        discount: round2(t.discount + c.discount),
      }),
      { count: 0, orders: 0, gross: 0, discount: 0 },
    );
  }
  return { codes, others, noCode };
}

// ── Traffic attribution ──────────────────────────────────────────────────────
export function parseReferrers(rows) {
  const out = (Array.isArray(rows) ? rows : []).map((row) => ({
    source: keyOf(row?.referrer_source), // null preserved = direct/unknown bucket
    sessions: num(row?.sessions),
  }));
  out.sort((a, b) => b.sessions - a.sessions);
  return out;
}

export function parseOrderReferrers(rows) {
  const out = (Array.isArray(rows) ? rows : []).map((row) => ({
    source: keyOf(row?.order_referrer_source),
    orders: num(row?.orders),
    // total_sales (tax/shipping-inclusive) — intentionally named `sales`, not `gross`.
    sales: round2(num(row?.total_sales)),
  }));
  out.sort((a, b) => b.orders - a.orders);
  return out;
}

export function parseCampaigns(rows, limit) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const campaign = keyOf(row?.utm_campaign);
    if (campaign == null) continue; // the null bucket dwarfs everything — drop it
    out.push({ campaign, sessions: num(row?.sessions) });
  }
  out.sort((a, b) => b.sessions - a.sessions);
  return out.slice(0, limit);
}

// ── Category mix (SKU prefix → category) ─────────────────────────────────────
// Resolution order: exact `overrides` match, then the LONGEST matching key in
// `prefixes`, else `fallback`. Case-insensitive throughout.
export function categorizeSku(sku, map) {
  const fallback = map?.fallback || "Other";
  const k = keyOf(sku);
  if (k == null) return fallback;
  const s = k.toUpperCase();
  const overrides = map?.overrides || {};
  for (const [code, cat] of Object.entries(overrides)) {
    if (code.toUpperCase() === s) return cat;
  }
  let best = null;
  for (const [prefix, cat] of Object.entries(map?.prefixes || {})) {
    const p = prefix.toUpperCase();
    if (s.startsWith(p) && (best == null || p.length > best.len)) {
      best = { len: p.length, cat };
    }
  }
  return best ? best.cat : fallback;
}

// Aggregate the SKU-level sales rows (the buildSkuSalesQL result) into a category
// mix. Also reports the top unmapped prefixes so the team can grow the map.
// `truncated` is set by the caller (true when the pull hit SKU_PULL_LIMIT rows).
export function buildCategoryMix(rows, map) {
  const fallback = map?.fallback || "Other";
  const cats = new Map(); // category -> {gross, qty}
  const unmapped = new Map(); // prefix -> {gross, qty}
  let totalGross = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const sku = keyOf(row?.product_variant_sku);
    const gross = num(row?.gross_sales);
    const qty = num(row?.quantity_ordered);
    const cat = categorizeSku(sku, map);
    const c = cats.get(cat) || { gross: 0, qty: 0 };
    c.gross += gross;
    c.qty += qty;
    cats.set(cat, c);
    totalGross += gross;
    if (cat === fallback && sku != null) {
      const prefix = sku.toUpperCase().slice(0, PREFIX_LEN);
      const u = unmapped.get(prefix) || { gross: 0, qty: 0 };
      u.gross += gross;
      u.qty += qty;
      unmapped.set(prefix, u);
    }
  }

  const outRows = [...cats.entries()]
    .map(([category, { gross, qty }]) => ({
      category,
      gross: round2(gross),
      qty,
      share: totalGross > 0 ? Math.round((gross / totalGross) * 10000) / 10000 : 0,
    }))
    .sort((a, b) => b.gross - a.gross);

  const outUnmapped = [...unmapped.entries()]
    .map(([prefix, { gross, qty }]) => ({ prefix, gross: round2(gross), qty }))
    .sort((a, b) => b.gross - a.gross)
    .slice(0, UNMAPPED_TOP);

  return { rows: outRows, unmapped: outUnmapped, truncated: false };
}
