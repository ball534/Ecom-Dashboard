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

import { round2, MONTHS } from "./aggregate.js";

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
// Promotion-calendar rows kept per month (sorted by revenue) before the tail is dropped.
export const DISC_MONTHLY_CAP = 8;
// Referrer names kept per year/month before the tail folds into an "Other" bucket.
export const TRAFFIC_TOP = 8;
// Landing pages pulled (ORDER BY sessions DESC — verified live against the SG store).
export const LANDING_LIMIT = 10;
// Label for the null-referrer bucket (no referrer recorded = typed URL / unknown).
export const DIRECT_LABEL = "Direct / unknown";
// Label for the null-discount_code group in the monthly discount rows: ShopifyQL puts
// automatic (no-code) discount money on the null-code group, so that group's discounts
// column IS the automatic-discount total for the month.
export const AUTO_DISCOUNT_LABEL = "Automatic discounts";

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

// Conversion funnel: per-month session counts for each funnel step. All four columns
// verified live on the SG store (2026-01: 167920 / 9768 / 2768 / 1428).
export function buildFunnelQL(start, end) {
  return `FROM sessions SHOW sessions, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout TIMESERIES month SINCE ${start} UNTIL ${end}`;
}

// Sessions per referrer NAME per month ("google", "instagram", ...; null = direct).
// referrer_name is finer-grained than the range-level referrer_source pull above.
export function buildTrafficMonthlyQL(start, end) {
  return `FROM sessions SHOW sessions GROUP BY referrer_name TIMESERIES month SINCE ${start} UNTIL ${end}`;
}

// Top landing pages by sessions over the whole range. ORDER BY sessions DESC LIMIT
// verified live (same acceptance caveat as the two product queries).
export function buildLandingQL(start, end, limit = LANDING_LIMIT) {
  return `FROM sessions SHOW sessions GROUP BY landing_page_path ORDER BY sessions DESC LIMIT ${limit} SINCE ${start} UNTIL ${end}`;
}

// Per-discount-code sales per month — feeds the Promotion Calendar and the voucher
// report's active-month date labels. Same dataset/columns as the range-level
// discountCodes pull, just split by month.
export function buildDiscountMonthlyQL(start, end) {
  return `FROM sales SHOW gross_sales, discounts, orders GROUP BY discount_code TIMESERIES month SINCE ${start} UNTIL ${end}`;
}

// One spec per underlying ShopifyQL call, so the handler and the preview script can
// fire/label them identically. `skuSales` feeds bestSellers.bySku AND categories;
// `discountCodes` + `discountMonthly` together feed discounts AND voucherReport.
export const INSIGHT_QUERIES = [
  { key: "skuSales", build: (s, e) => buildSkuSalesQL(s, e) },
  { key: "titleSales", build: (s, e, l) => buildTitleSalesQL(s, e, l) },
  { key: "discountCodes", build: (s, e) => buildDiscountCodesQL(s, e) },
  { key: "referrers", build: (s, e) => buildReferrersQL(s, e) },
  { key: "orderReferrers", build: (s, e) => buildOrderReferrersQL(s, e) },
  { key: "campaigns", build: (s, e) => buildCampaignsQL(s, e) },
  { key: "funnel", build: (s, e) => buildFunnelQL(s, e) },
  { key: "trafficMonthly", build: (s, e) => buildTrafficMonthlyQL(s, e) },
  { key: "landing", build: (s, e) => buildLandingQL(s, e) },
  { key: "discountMonthly", build: (s, e) => buildDiscountMonthlyQL(s, e) },
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
// Year + 0-based month index from a TIMESERIES month label ("2026-01-01" → 2026, 0).
// Same tolerant parse as lib/shopifyql.js; anything unparseable yields nulls so the
// row is skipped rather than mis-bucketed.
function monthOf(label) {
  const m = /^(\d{4})-(\d{2})/.exec(String(label ?? ""));
  if (!m) return { year: null, month: null };
  const month = Number(m[2]) - 1;
  if (month < 0 || month >= MONTHS) return { year: null, month: null };
  return { year: Number(m[1]), month };
}
const emptyMonths = () => Array.from({ length: MONTHS }, () => null);
// Short month names for the voucher report's "Jun – Jul" active-period labels.
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

// ── Conversion funnel (sessions dataset, monthly) ────────────────────────────
// { "<year>": { cart:[12], checkout:[12], converted:[12] } } — one entry per year the
// rows actually cover, months without data left null. `sessions` is the presence
// column (ShopifyQL pads future/empty months with 0 rows — those must stay null, same
// convention as lib/shopifyql.js). Returns null when no month has data, so the API's
// composite null rule ("section null only when its sources yielded nothing") holds.
export function parseFunnel(rows) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const { year, month } = monthOf(row?.month);
    if (year == null) continue;
    if (!num(row?.sessions)) continue; // no sessions → no data this month → leave null
    const y =
      out[year] ||
      (out[year] = { cart: emptyMonths(), checkout: emptyMonths(), converted: emptyMonths() });
    y.cart[month] = toNum(row?.sessions_with_cart_additions);
    y.checkout[month] = toNum(row?.sessions_that_reached_checkout);
    y.converted[month] = toNum(row?.sessions_that_completed_checkout);
  }
  return Object.keys(out).length ? out : null;
}

// ── Monthly discount rows (Promotion Calendar) ───────────────────────────────
// { "<year>": [12 x (rows|null)] }, each month's rows shaped
// [name, revenue, orders, discountGiven, "code"|"auto"], sorted by revenue desc and
// capped. The null-code group is ShopifyQL's bucket for orders WITHOUT a code — its
// discounts column is the automatic-discount money, so it becomes one "Automatic
// discounts" row per month, but only when it actually gave a discount (a month where
// that group gave $0 has no automatic promotion to report).
export function parseDiscountMonthly(rows, cap = DISC_MONTHLY_CAP) {
  const years = {}; // year -> [12 x ({codes:[], auto} | null)]
  for (const row of Array.isArray(rows) ? rows : []) {
    const { year, month } = monthOf(row?.month);
    if (year == null) continue;
    const gross = num(row?.gross_sales);
    const orders = num(row?.orders);
    const discount = Math.abs(num(row?.discounts)); // reported negative — flip it
    if (!gross && !orders && !discount) continue; // padded empty month → stays null
    const y = years[year] || (years[year] = emptyMonths());
    const m = y[month] || (y[month] = { codes: [], auto: null });
    const code = keyOf(row?.discount_code);
    if (code == null) {
      // Aggregate all null-code rows (normally one per month) into the auto bucket.
      const a = m.auto || (m.auto = { gross: 0, orders: 0, discount: 0 });
      a.gross += gross;
      a.orders += orders;
      a.discount += discount;
    } else {
      m.codes.push([code, round2(gross), orders, round2(discount), "code"]);
    }
  }

  const out = {};
  for (const [year, months] of Object.entries(years)) {
    out[year] = months.map((m) => {
      if (!m) return null;
      const codeRows = [...m.codes].sort((a, b) => b[1] - a[1]); // revenue desc
      const monthRows = codeRows.slice(0, cap);
      // Fold the tail past the cap into one summary row (mirrors parseDiscountCodes'
      // "others" fold) so month totals derived from these rows are never understated.
      const tail = codeRows.slice(cap);
      if (tail.length) {
        monthRows.push([
          "Other codes (" + tail.length + ")",
          round2(tail.reduce((s, r) => s + r[1], 0)),
          tail.reduce((s, r) => s + r[2], 0),
          round2(tail.reduce((s, r) => s + r[3], 0)),
          "code",
        ]);
      }
      if (m.auto && m.auto.discount > 0) {
        // Only the `discounts` column of the null-code group is genuinely automatic-
        // discount money. Its gross/orders are dominated by plain undiscounted orders
        // (the same reason buildVoucherReport excludes this group), so attributing them
        // to a "promotion" would inflate it by an order of magnitude. Revenue/orders
        // are therefore served as null — not attributable — never a fabricated figure.
        monthRows.push([AUTO_DISCOUNT_LABEL, null, null, round2(m.auto.discount), "auto"]);
      }
      if (!monthRows.length) return null;
      return monthRows;
    });
  }
  return Object.keys(out).length ? out : null;
}

// ── Monthly traffic sources (referrer_name × month) ──────────────────────────
// { "<year>": { sources: [[name, sessions], ...],            // whole year, top N + "Other"
//               monthly: { "<0-based month>": [[name, sessions], ...], ... } } }
// The null referrer bucket (no referrer recorded) is labelled DIRECT_LABEL — it is by
// far the largest bucket, so dropping it would misstate every share. Only months that
// actually have sessions get a `monthly` entry.
export function parseTrafficMonthly(rows, top = TRAFFIC_TOP) {
  const years = {}; // year -> { totals: Map(name -> sessions), months: Map(idx -> Map) }
  for (const row of Array.isArray(rows) ? rows : []) {
    const { year, month } = monthOf(row?.month);
    if (year == null) continue;
    const sessions = num(row?.sessions);
    if (!sessions) continue; // a 0-session row carries no information
    const name = keyOf(row?.referrer_name) ?? DIRECT_LABEL;
    const y = years[year] || (years[year] = { totals: new Map(), months: new Map() });
    y.totals.set(name, (y.totals.get(name) || 0) + sessions);
    let m = y.months.get(month);
    if (!m) y.months.set(month, (m = new Map()));
    m.set(name, (m.get(name) || 0) + sessions);
  }

  // Top-N by sessions; everything past the cap folds into a real-sum "Other" bucket.
  const topAndOther = (map) => {
    const arr = [...map.entries()].sort((a, b) => b[1] - a[1]);
    const head = arr.slice(0, top);
    const tail = arr.slice(top);
    if (tail.length) head.push(["Other", tail.reduce((t, [, s]) => t + s, 0)]);
    return head;
  };

  const out = {};
  for (const [year, y] of Object.entries(years)) {
    const monthly = {};
    for (const [idx, m] of [...y.months.entries()].sort((a, b) => a[0] - b[0])) {
      monthly[idx] = topAndOther(m);
    }
    out[year] = { sources: topAndOther(y.totals), monthly };
  }
  return Object.keys(out).length ? out : null;
}

// ── Landing pages ────────────────────────────────────────────────────────────
// [[path, sessions], ...] sorted by sessions desc. Rows without a path can't be
// labelled, so they're dropped (the query is already ORDER BY sessions DESC, but the
// sort is repeated here so the parser doesn't depend on it).
export function parseLandingPages(rows, limit = LANDING_LIMIT) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const path = keyOf(row?.landing_page_path);
    if (path == null) continue;
    out.push([path, num(row?.sessions)]);
  }
  out.sort((a, b) => b[1] - a[1]);
  return out.slice(0, limit);
}

// ── Voucher report (Promotions tab, Website channel) ────────────────────────
// Built from the RANGE-level discount rows (uncapped per-code totals + the range-wide
// store totals) plus the RAW monthly rows (for each code's first→last active month —
// raw, not the capped parseDiscountMonthly output, so a small code's date span isn't
// truncated by the per-month cap). Every field the APIs cannot supply is null and the
// UI renders "—": mech (offer mechanics need the discount definition), sent/rate
// (email-send data needs the ESP), store.target (manual targets, separate section).
export function buildVoucherReport(rangeRows, monthlyRows) {
  if (!Array.isArray(rangeRows)) return null;

  // Per-code totals + whole-range store totals from the SAME range pull. The no-code
  // group counts toward the store totals (it is real revenue) but is not a voucher row
  // — its revenue is mostly undiscounted orders, not a promotion's.
  let totalGross = 0;
  let totalOrders = 0;
  const codes = new Map(); // code -> { gross, orders, disc }
  for (const row of rangeRows) {
    const gross = num(row?.gross_sales);
    const orders = num(row?.orders);
    const disc = Math.abs(num(row?.discounts));
    totalGross += gross;
    totalOrders += orders;
    const code = keyOf(row?.discount_code);
    if (code == null) continue;
    const c = codes.get(code) || { gross: 0, orders: 0, disc: 0 };
    c.gross += gross;
    c.orders += orders;
    c.disc += disc;
    codes.set(code, c);
  }

  // First → last month each code was actually used, from the raw monthly rows.
  const before = (a, b) => a.year < b.year || (a.year === b.year && a.month < b.month);
  const active = new Map(); // code -> { first: {year, month}, last: {year, month} }
  for (const row of Array.isArray(monthlyRows) ? monthlyRows : []) {
    const code = keyOf(row?.discount_code);
    if (code == null) continue;
    if (!num(row?.gross_sales) && !num(row?.orders) && !Math.abs(num(row?.discounts))) continue;
    const { year, month } = monthOf(row?.month);
    if (year == null) continue;
    const pos = { year, month };
    const cur = active.get(code);
    if (!cur) active.set(code, { first: pos, last: pos });
    else {
      if (before(pos, cur.first)) cur.first = pos;
      if (before(cur.last, pos)) cur.last = pos;
    }
  }
  // "Jun" / "Jun – Jul" within one year; years spelled out when the span crosses them.
  const spanLabel = (s) => {
    if (!s) return null;
    const { first, last } = s;
    if (first.year !== last.year) {
      return `${MONTH_NAMES[first.month]} ${first.year} – ${MONTH_NAMES[last.month]} ${last.year}`;
    }
    if (first.month === last.month) return MONTH_NAMES[first.month];
    return `${MONTH_NAMES[first.month]} – ${MONTH_NAMES[last.month]}`;
  };

  const rows = [...codes.entries()].map(([code, c]) => {
    const sales = round2(c.gross);
    const disc = round2(c.disc);
    // Contract formula: discount as a share of (sales + discount), null-safe.
    const discDenom = sales + disc;
    return {
      ch: "Website",
      title: code,
      mech: null,
      date: spanLabel(active.get(code)),
      sales,
      aov: c.orders > 0 ? round2(sales / c.orders) : null,
      disc,
      discPct: discDenom > 0 ? round2((disc / discDenom) * 100) : null,
      sent: null,
      redeemed: c.orders,
      rate: null,
    };
  });
  rows.sort((a, b) => b.sales - a.sales);

  const actual = round2(totalGross);
  return {
    store: {
      actual,
      aov: totalOrders > 0 ? round2(actual / totalOrders) : null,
      target: null,
    },
    rows,
  };
}
