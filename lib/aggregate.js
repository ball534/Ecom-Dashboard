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

  // Revenue = Shopify "Gross sales" = product price × quantity, BEFORE discounts,
  // returns, taxes and shipping. Prices here are tax-inclusive (SG GST), so we strip
  // the embedded tax per line at that line's own rate to match the admin's pre-tax
  // gross-sales figure. Units = GROSS quantity ordered (Shopify's "items ordered" —
  // not net of refunds, not excluding cancelled). Both come from the line items.
  //
  // Discounts are reconstructed the SAME way Shopify's Analytics "Discounts" line is:
  // the sum of every line's discountAllocations (product + allocated cart discounts),
  // with the embedded tax stripped per line so it is tax-EXCLUDED. Using the order's
  // currentTotalDiscounts instead over-counts by the embedded GST (~6%) and pulls AOV
  // off, because that figure is tax-inclusive — see scripts calibration against the
  // admin (48,185 reported vs 48,088 reconstructed; AOV 62.88 vs 62.91).
  const taxIncluded = node?.taxesIncluded !== false; // SG store reports tax-inclusive
  let amount = 0;
  let units = 0;
  let discounts = 0;
  // Per-line records for the order-derived sections (sale mix). `lineGross` is the
  // line's tax-stripped gross (same math as `amount`, so revSale+revFull tallies with
  // rev). `unitPrice` is the sold unit price AS LISTED — originalTotal/quantity with
  // the tax left IN — because it is compared against the variant's catalogue
  // price/compareAtPrice, which Shopify stores tax-inclusive on this shop. Verified
  // live: raw unit price == variant.price on 25/25 sampled lines; the tax-stripped
  // value matched only $0 freebie lines. Stripping it would misclassify any
  // full-price item whose compareAtPrice is set equal to its price as "sale".
  const lines = [];
  for (const e of node?.lineItems?.edges ?? []) {
    const n = e?.node;
    const qty = Number(n?.quantity ?? 0) || 0;
    units += qty;
    const lineTotal = money(n?.originalTotalSet);
    const rate = (n?.taxLines ?? []).reduce((s, t) => s + (Number(t?.rate) || 0), 0);
    const div = taxIncluded && rate ? 1 + rate : 1;
    amount += lineTotal / div;
    const alloc = (n?.discountAllocations ?? []).reduce(
      (s, a) => s + money(a?.allocatedAmountSet),
      0,
    );
    discounts += alloc / div;
    lines.push({
      variantId: n?.variant?.id ?? null,
      sku: n?.sku ?? null,
      quantity: qty,
      unitPrice: qty > 0 ? lineTotal / qty : null,
      lineGross: lineTotal / div,
    });
  }

  // Pickup vs delivery. Confirmed discriminator: pickup orders carry a shipping line
  // titled "Pick Up @ <store name> (<address>)"; everything else ("Free Shipping",
  // "Standard", …) is a courier delivery. fulfillmentOrders.deliveryMethod is
  // access-denied on this token, so the title is the only reliable signal.
  const shipTitle = node?.shippingLine?.title ?? null;
  const isPickup = /^Pick Up @ /i.test(String(shipTitle ?? ""));
  const pickupPoint = isPickup
    ? String(shipTitle)
        .replace(/^Pick Up @ /i, "")
        .replace(/\s*\([^)]*\)\s*$/, "") // strip the trailing "(address)" suffix
        .trim() || null
    : null;

  // Delivery region = first 2 characters of the shipping postcode (SG postal district;
  // MY postcodes truncate the same way). ONLY for non-pickup orders: on a pickup order
  // the shippingAddress is the customer's HOME address, which must never be counted as
  // a delivery region. The raw zip is dropped here — only the 2-char district survives.
  const zip = String(node?.shippingAddress?.zip ?? "").trim();
  const shipZipDistrict = !isPickup && zip.length >= 2 ? zip.slice(0, 2) : null;

  // Voucher orders = orders that redeemed a gift card or store credit (a true
  // monetary "voucher"), detected via the payment gateways used on the order.
  // NOTE: this is much narrower than "any discount code" — see README.
  const gateways = Array.isArray(node?.paymentGatewayNames) ? node.paymentGatewayNames : [];
  const usedVoucher = gateways.some((g) => /gift[_\s-]?card|store[_\s-]?credit/i.test(String(g)));

  const numOrders =
    node?.customer && node.customer.numberOfOrders != null
      ? Number(node.customer.numberOfOrders)
      : null;
  const customerId = node?.customer?.id ?? null;

  // Sales metrics exclude test orders and cancelled orders (matches Shopify Analytics).
  const test = Boolean(node?.test);
  const cancelled = Boolean(node?.cancelledAt);

  return {
    createdAt: node?.createdAt,
    amount,
    discounts,
    units,
    usedVoucher,
    numOrders,
    customerId,
    test,
    cancelled,
    isPickup,
    pickupPoint,
    shipZipDistrict,
    lines,
  };
}

// Pickup-vs-delivery split over a set of normalized orders (whole range, order counts).
// Returns { pickup, delivery, points: [[name, n], ...], regions: [["District XX", n], ...] }
// with both lists sorted by count desc — the shape sections.fulfillment serves verbatim.
// A store with zero pickup orders is a REAL zero (still served). When the shipping
// address was dropped for scope reasons, shipZipDistrict is null on every order and
// regions is simply empty — the pickup split itself still works off shippingLine.
export function buildFulfillmentSection(orders) {
  let pickup = 0;
  let delivery = 0;
  const points = new Map();
  const regions = new Map();
  for (const o of orders || []) {
    // Cancelled orders are kept by fetchOrders (the items report includes them), but
    // the panels beside these sections read ShopifyQL figures that exclude them —
    // skip them here so pickup/delivery counts tie to the Orders KPI.
    if (o?.cancelled) continue;
    if (o?.isPickup) {
      pickup += 1;
      const name = o.pickupPoint || "Unknown";
      points.set(name, (points.get(name) || 0) + 1);
    } else {
      delivery += 1;
      if (o?.shipZipDistrict) {
        const label = `District ${o.shipZipDistrict}`;
        regions.set(label, (regions.get(label) || 0) + 1);
      }
    }
  }
  const sortedDesc = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return { pickup, delivery, points: sortedDesc(points), regions: sortedDesc(regions) };
}

// Sale-vs-full-price mix over a set of normalized orders. A line is "sale" iff its
// variant's CURRENT compareAtPrice parses to a number above the sold unit price
// (price-based markdown, catalogue-snapshot semantics). Deleted/unknown variants —
// absent from `compareAtByVariant` — count as full-price, as do lines with no
// compareAtPrice at all. NOTHING here is estimated: every figure is a sum over the
// pulled order lines.
//
// Returns { sku: { sale, full },                          // distinct SKUs sold in range
//           years: { YYYY: { revSale: [12], revFull: [12], itemSale: [12], itemFull: [12] } } }
// Monthly arrays follow the dashboard's null convention: months that received no
// order lines stay null; a month with lines reads 0 in the buckets it didn't touch.
// A SKU that sold at markdown in ANY line counts on the sale side of the SKU split.
export function buildSaleMixSection(orders, compareAtByVariant, { timeZone = "Asia/Singapore" } = {}) {
  const years = {};
  const ensureYear = (y) =>
    (years[y] ||= {
      revSale: emptyYear(),
      revFull: emptyYear(),
      itemSale: emptyYear(),
      itemFull: emptyYear(),
    });
  const skuSale = new Map(); // sku (or variant id when sku is blank) -> ever sold at markdown?

  for (const o of orders || []) {
    if (!o?.createdAt || !Array.isArray(o.lines)) continue;
    if (o.cancelled) continue; // tie to the ShopifyQL revenue the panel sits beside
    const { year, month } = monthIndexInTZ(o.createdAt, timeZone);
    const yr = ensureYear(year);
    for (const ln of o.lines) {
      const v = ln.variantId != null ? compareAtByVariant?.get(ln.variantId) : null;
      const compareAt = v ? parseFloat(v.compareAtPrice) : NaN;
      // Half-cent epsilon: unitPrice is reconstructed as originalTotal/quantity, and
      // float division can land a few ULP below the true price (e.g. 45.15/3 =
      // 15.049999…), which would misclassify a full-price item whose compareAtPrice
      // equals its price. Prices are 2dp, so anything within 0.005 is "not above".
      const sale = Number.isFinite(compareAt) && ln.unitPrice != null && compareAt > ln.unitPrice + 0.005;
      const rev = sale ? yr.revSale : yr.revFull;
      const items = sale ? yr.itemSale : yr.itemFull;
      rev[month] = (rev[month] || 0) + (ln.lineGross || 0);
      items[month] = (items[month] || 0) + (ln.quantity || 0);
      const key = ln.sku || ln.variantId;
      if (key != null) skuSale.set(key, sale || skuSale.get(key) === true);
    }
  }

  for (const y of Object.keys(years)) {
    const yr = years[y];
    // Round currency to cents, then make months that HAVE data read 0 (not blank)
    // in the buckets they didn't touch — same convention as bucketOrders.
    yr.revSale = yr.revSale.map((v) => (v == null ? null : round2(v)));
    yr.revFull = yr.revFull.map((v) => (v == null ? null : round2(v)));
    for (let i = 0; i < MONTHS; i++) {
      const touched = [yr.revSale, yr.revFull, yr.itemSale, yr.itemFull].some((a) => a[i] != null);
      if (!touched) continue;
      for (const a of [yr.revSale, yr.revFull, yr.itemSale, yr.itemFull]) {
        if (a[i] == null) a[i] = 0;
      }
    }
  }

  let sale = 0;
  let full = 0;
  for (const isSale of skuSale.values()) isSale ? (sale += 1) : (full += 1);
  return { sku: { sale, full }, years };
}

// Classify each order as the customer's FIRST-ever purchase ("new") or not
// ("returning"), and return a new array with an `isNew` flag (true | false | null).
//
// Accurate without pulling full order history: because the dashboard's live window
// is the CURRENT calendar year, any order a customer has OUTSIDE this set must be a
// PRIOR-year order (no future orders exist yet). So if a customer's lifetime order
// count (customer.numberOfOrders, as of now) equals the number of their orders in
// this window, their first-ever order is in-window — their earliest in-window order
// is "new" and the rest are "returning". If their lifetime count is higher, they
// already existed before this year, so every order here is "returning".
// `isNew` is null when the order has no customer (guest checkout).
export function classifyNewReturning(orders) {
  const liveCount = new Map(); // customerId -> orders in this window
  const earliestIdx = new Map(); // customerId -> index of their earliest order here
  orders.forEach((o, i) => {
    if (o?.customerId == null) return;
    liveCount.set(o.customerId, (liveCount.get(o.customerId) || 0) + 1);
    const t = Date.parse(o.createdAt);
    const cur = earliestIdx.get(o.customerId);
    if (cur == null || t < cur.t) earliestIdx.set(o.customerId, { i, t });
  });

  return orders.map((o, i) => {
    if (o?.customerId == null || o?.numOrders == null) return { ...o, isNew: null };
    const firstOrderIsInWindow = o.numOrders <= (liveCount.get(o.customerId) || 0);
    const isEarliestHere = earliestIdx.get(o.customerId)?.i === i;
    return { ...o, isNew: Boolean(firstOrderIsInWindow && isEarliestHere) };
  });
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

  // Tag each order new/returning before bucketing (needs the full set per customer).
  const classified = classifyNewReturning(orders);

  // New/returning are counted as DISTINCT CUSTOMERS per month, not orders — a
  // customer who orders 3× in a month is one returning customer (matches Shopify's
  // "first-time vs returning customers" report).
  const newCust = {}, retCust = {};
  for (const y of years) {
    newCust[y] = Array.from({ length: MONTHS }, () => new Set());
    retCust[y] = Array.from({ length: MONTHS }, () => new Set());
  }

  for (const o of classified) {
    if (!o?.createdAt) continue;
    const { year, month } = monthIndexInTZ(o.createdAt, timeZone);
    if (!years.includes(year)) continue;
    bump("rev", year, month, o.amount);
    bump("ord", year, month, 1);
    bump("uni", year, month, o.units);
    bump("dis", year, month, o.discounts);
    bump("vou", year, month, o.usedVoucher ? 1 : 0);
    if (o.customerId != null && o.isNew != null) {
      (o.isNew ? newCust : retCust)[year][month].add(o.customerId);
    }
  }

  // Resolve customer sets to counts, only for months that actually had orders.
  // A customer who is "new" in a month is not also counted as "returning" that month.
  for (const y of years) {
    for (let i = 0; i < MONTHS; i++) {
      if (out.ord[y][i] == null) continue;
      const nw = newCust[y][i];
      let ret = 0;
      for (const id of retCust[y][i]) if (!nw.has(id)) ret += 1;
      out.cust[y][i] = nw.size;
      out.ret[y][i] = ret;
    }
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
