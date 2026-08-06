// lib/marketplace.js
// Turns normalized marketplace orders (lib/shopee.js, lib/lazada.js) into the two
// structures the dashboard renders:
//
//   channel series  -> CHANNELMIX[brand][year][channel] = [12 monthly revenue]
//   voucher rows    -> the marketplace half of the Voucher Performance report, in the
//                      SAME row shape lib/insights.js#buildVoucherReport emits for the
//                      website, so the deck renders both without a special case.
//
// Why this exists at all: every order in the Shopify stores has source_name "web" —
// marketplace sales never touch Shopify — so Channel Mix is impossible from Shopify
// alone (see INTEGRATION-PLAN.md). These are the only figures on the dashboard that come
// from outside Shopify's ledger, so two differences are stated rather than smoothed over:
//
//   • A marketplace order's `total` is the value the marketplace reports for the order
//     (what the buyer paid). Shopify's Website figure is ShopifyQL Gross Sales. They are
//     close but NOT the same definition; the panel says so.
//   • Cancelled/unpaid orders are excluded, matching how the Shopify KPIs exclude
//     cancelled orders.
//
// A month with no orders is null, not 0 — the dashboard's "no data" and "no sales" must
// stay distinguishable.

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export const MARKETPLACE_CHANNELS = ["Shopee", "Lazada"];

const round2 = (n) => Math.round(n * 100) / 100;
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Orders that count as revenue: a real date, a positive total, not cancelled. */
function usable(o) {
  return o && isDate(o.date) && !o.cancelled && Number.isFinite(o.total);
}

/**
 * Monthly revenue per year: { "2026": [12 numbers or nulls] }.
 * Only years present in `years` are emitted (or every year seen, when omitted).
 */
export function buildChannelSeries(orders, { years } = {}) {
  const out = {};
  const want = years ? new Set(years.map(Number)) : null;
  for (const o of Array.isArray(orders) ? orders : []) {
    if (!usable(o)) continue;
    const y = Number(o.date.slice(0, 4));
    if (want && !want.has(y)) continue;
    const mi = Number(o.date.slice(5, 7)) - 1;
    const arr = out[y] || (out[y] = Array(12).fill(null));
    arr[mi] = (arr[mi] || 0) + o.total;
  }
  for (const y of Object.keys(out)) {
    out[y] = out[y].map((v) => (v == null ? null : round2(v)));
  }
  return Object.keys(out).length ? out : null;
}

/** Order counts per month, so the front-end can label coverage honestly. */
export function buildChannelOrderCounts(orders, { years } = {}) {
  const out = {};
  const want = years ? new Set(years.map(Number)) : null;
  for (const o of Array.isArray(orders) ? orders : []) {
    if (!usable(o)) continue;
    const y = Number(o.date.slice(0, 4));
    if (want && !want.has(y)) continue;
    const mi = Number(o.date.slice(5, 7)) - 1;
    const arr = out[y] || (out[y] = Array(12).fill(null));
    arr[mi] = (arr[mi] || 0) + 1;
  }
  return Object.keys(out).length ? out : null;
}

/** Whole-window totals, for the voucher deck's store line. */
export function channelTotals(orders) {
  let gross = 0;
  let count = 0;
  for (const o of Array.isArray(orders) ? orders : []) {
    if (!usable(o)) continue;
    gross += o.total;
    count += 1;
  }
  return {
    actual: count ? round2(gross) : null,
    orders: count,
    aov: count ? round2(gross / count) : null,
  };
}

/**
 * One row per voucher code actually used, in the voucher-report row contract:
 *   { ch, title, mech, date, sales, aov, disc, discPct, sent, redeemed, rate }
 *
 * `sent` and `rate` need the campaign that distributed the voucher (the marketplaces
 * don't report it), so they stay null → "—". `disc` is null unless the marketplace
 * reported a per-order discount amount: a discount inferred from a price would be a
 * guess, and this dashboard shows no guesses.
 */
export function buildMarketplaceVouchers(orders, { channel } = {}) {
  const byCode = new Map();
  for (const o of Array.isArray(orders) ? orders : []) {
    if (!usable(o) || !o.voucherCode) continue;
    const code = String(o.voucherCode).trim();
    if (!code) continue;
    let c = byCode.get(code);
    if (!c) {
      c = { sales: 0, orders: 0, disc: 0, discKnown: false, first: o.date, last: o.date };
      byCode.set(code, c);
    }
    c.sales += o.total;
    c.orders += 1;
    if (o.discount != null && Number.isFinite(o.discount)) {
      c.disc += Math.abs(o.discount);
      c.discKnown = true;
    }
    if (o.date < c.first) c.first = o.date;
    if (o.date > c.last) c.last = o.date;
  }

  const span = (a, b) => {
    const am = Number(a.slice(5, 7)) - 1;
    const bm = Number(b.slice(5, 7)) - 1;
    const ay = a.slice(0, 4);
    const by = b.slice(0, 4);
    if (ay !== by) return `${MONTH_NAMES[am]} ${ay} – ${MONTH_NAMES[bm]} ${by}`;
    return am === bm ? MONTH_NAMES[am] : `${MONTH_NAMES[am]} – ${MONTH_NAMES[bm]}`;
  };

  return [...byCode.entries()]
    .map(([code, c]) => {
      const sales = round2(c.sales);
      const disc = c.discKnown ? round2(c.disc) : null;
      const denom = disc != null ? sales + disc : 0;
      return {
        ch: channel,
        title: code,
        mech: null,
        date: span(c.first, c.last),
        sales,
        aov: c.orders ? round2(sales / c.orders) : null,
        disc,
        discPct: denom > 0 ? round2((disc / denom) * 100) : null,
        sent: null,
        redeemed: c.orders,
        rate: null,
      };
    })
    .sort((a, b) => b.sales - a.sales);
}
