// scripts/probe-datasets.js
// Asks the LIVE store which ShopifyQL datasets and columns it will actually serve.
//
// Shopify documents ~40 schemas, but which ones a given store answers depends on its
// plan, its granted scopes and its protected-customer-data approval — so the docs can
// only ever be a candidate list. This script turns that list into fact: it runs one
// tiny query per candidate against a short date window and reports PASS/FAIL with the
// columns that actually came back.
//
// Everything here is READ-ONLY: `FROM <dataset> SHOW <cols> LIMIT 1..3`. Nothing is
// written, and every query is scoped to a narrow window so the cost is trivial.
//
// Usage:  node scripts/probe-datasets.js [brand] [start] [end]
//   defaults: SG, first day of last month, today.
//
// Read the output as a build list: a PASS means the panel is buildable today; a FAIL
// tells you whether it's a missing scope (fixable) or an unsupported column (isn't).

import { loadEnv } from "./_env.js";
import { resolveConfig, envNames, shopifyQL, ShopifyError } from "../api/_shopify.js";

loadEnv();

const brand = (process.argv[2] || "SG").toUpperCase();
const cfg = await resolveConfig(process.env, brand);

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Singapore",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const defaultStart = (() => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1, 1);
  return d.toISOString().slice(0, 10);
})();
const start = process.argv[3] || defaultStart;
const end = process.argv[4] || today;

if (!cfg.token || !cfg.domain) {
  console.error(
    `No Shopify credentials for brand "${brand}". Set ${envNames(brand).domain} and ` +
      `${envNames(brand).token} (or the CLIENT_/SECRET_ pair) in .env.`,
  );
  process.exit(1);
}

console.log(`Probing ${cfg.domain} (brand ${brand}, API ${cfg.version}) over ${start} → ${end}\n`);

// Each candidate is one question: "can this store serve the data behind panel X?"
// `why` is what it would unlock, so the output doubles as a prioritised build list.
const W = `SINCE ${start} UNTIL ${end}`;
const CANDIDATES = [
  // ── datasets the dashboard already relies on (regression check) ──────────────
  { group: "in use", label: "sales core", ql: `FROM sales SHOW gross_sales, net_sales, orders, discounts ${W}`, why: "the revenue KPIs" },
  { group: "in use", label: "sessions core", ql: `FROM sessions SHOW sessions, conversion_rate ${W}`, why: "sessions + conversion" },
  { group: "in use", label: "fulfillments", ql: `FROM fulfillments SHOW orders_fulfilled ${W}`, why: "orders-fulfilled card" },

  // ── replacing the expensive Orders API pull ─────────────────────────────────
  // The dashboard pages EVERY order (line items and all) for three things. If these
  // pass, most of that pull — the slowest thing on the page — can be deleted.
  { group: "kill the orders pull", label: "sales: gift-card sales", ql: `FROM sales SHOW gift_card_sales, gift_card_discounts ${W}`, why: "the Voucher metric without paging all orders" },
  { group: "kill the orders pull", label: "gift_cards dataset", ql: `FROM gift_cards SHOW gift_cards_issued, gift_cards_redeemed ${W}`, why: "authoritative voucher/gift-card figures" },
  { group: "kill the orders pull", label: "payments by method", ql: `FROM payments SHOW payment_amount GROUP BY payment_method ${W}`, why: "gift-card/store-credit orders directly" },
  { group: "kill the orders pull", label: "sales by shipping method", ql: `FROM sales SHOW orders GROUP BY shipping_method_name ${W}`, why: "pick-up vs delivery WITHOUT the orders pull" },
  { group: "kill the orders pull", label: "sales by billing country", ql: `FROM sales SHOW gross_sales, orders GROUP BY billing_country ${W}`, why: "the template's Sales by Country panel, for real" },
  { group: "kill the orders pull", label: "sales by shipping region", ql: `FROM sales SHOW orders GROUP BY shipping_region ${W}`, why: "delivery regions without protected-address scope" },
  { group: "kill the orders pull", label: "sales by compare-at price", ql: `FROM sales SHOW gross_sales GROUP BY product_variant_compare_at_price ${W}`, why: "sale vs full-price without the compareAt lookup" },

  // ── returns: a fashion retailer's biggest blind spot here ────────────────────
  { group: "returns", label: "returns dataset", ql: `FROM returns SHOW returned_quantity ${W}`, why: "return rate — nothing on the dashboard covers this" },
  { group: "returns", label: "returns by reason", ql: `FROM returns SHOW returned_quantity GROUP BY return_reason ${W}`, why: "WHY product comes back (sizing, quality, …)" },
  { group: "returns", label: "sales reversals", ql: `FROM sales SHOW returns, net_sales ${W}`, why: "returns netted against sales" },

  // ── margin: the dashboard has no cost data at all ────────────────────────────
  { group: "margin", label: "profitability dataset", ql: `FROM profitability SHOW net_sales, cost_of_goods_sold, gross_profit ${W}`, why: "gross margin %, not just revenue" },
  { group: "margin", label: "profitability by product", ql: `FROM profitability SHOW gross_profit GROUP BY product_title ${W}`, why: "which products actually make money" },
  { group: "margin", label: "shipping + fulfilment cost", ql: `FROM profitability SHOW shipping_costs, fulfillment_costs, duties ${W}`, why: "true cost to serve" },

  // ── customers: retention beyond the new-vs-returning split ───────────────────
  { group: "customers", label: "customers dataset", ql: `FROM customers SHOW customers, lifetime_spend, average_spend_per_order ${W}`, why: "LTV + repeat behaviour" },
  { group: "customers", label: "days since last order", ql: `FROM customers SHOW customers GROUP BY days_since_last_order ${W}`, why: "lapsing-customer cohorts" },

  // ── inventory: sell-through, the other half of a merchandising view ──────────
  { group: "inventory", label: "inventory dataset", ql: `FROM inventory SHOW ending_quantity, sell_through_rate, days_of_inventory_remaining ${W}`, why: "sell-through + weeks of cover" },
  { group: "inventory", label: "inventory by location", ql: `FROM inventory_by_location SHOW ending_quantity GROUP BY location_name ${W}`, why: "stock per store" },
  { group: "inventory", label: "days out of stock", ql: `FROM inventory SHOW days_out_of_stock GROUP BY product_title ${W}`, why: "lost sales from stockouts" },

  // ── on-site search: what customers ask for and don't find ────────────────────
  { group: "search", label: "search queries", ql: `FROM search_queries SHOW search_query_volume GROUP BY search_query ${W}`, why: "top searches — demand signal" },
  { group: "search", label: "searches with no results", ql: `FROM searches SHOW search_volume GROUP BY search_query, results_returned ${W}`, why: "demand you're not meeting" },
  { group: "search", label: "search conversions", ql: `FROM search_conversions SHOW purchase_conversion_rate ${W}`, why: "does search convert?" },

  // ── attribution: better than the current referrer grouping ───────────────────
  { group: "attribution", label: "campaign sales (multi-model)", ql: `FROM campaign_sales SHOW orders, total_sales GROUP BY campaign_name ${W}`, why: "first/last-click attribution per campaign" },
  { group: "attribution", label: "campaign sessions", ql: `FROM campaign_sessions SHOW sessions, conversion_rate GROUP BY campaign_name ${W}`, why: "campaign funnel, not just sessions" },

  // ── sessions: dimensions the dashboard doesn't use ───────────────────────────
  { group: "sessions+", label: "sessions by visitor location", ql: `FROM sessions SHOW sessions GROUP BY visitor_country ${W}`, why: "the template's Sessions by Visitor Location panel" },
  { group: "sessions+", label: "sessions by device", ql: `FROM sessions SHOW sessions, conversion_rate GROUP BY device_type ${W}`, why: "mobile vs desktop conversion gap" },

  // ── checkout health ──────────────────────────────────────────────────────────
  { group: "checkout", label: "payment attempts", ql: `FROM payment_attempts SHOW payment_attempts, authorization_rate ${W}`, why: "revenue lost to failed payments" },
  { group: "checkout", label: "fulfilment speed", ql: `FROM fulfillments SHOW time_to_fulfillment, time_to_delivery ${W}`, why: "delivery promise vs reality" },
  { group: "checkout", label: "web performance", ql: `FROM web_performance SHOW largest_contentful_paint GROUP BY page_type ${W}`, why: "site speed vs conversion" },

  // ── retail (POS) — the 75+ stores, currently absent from this dashboard ──────
  { group: "retail", label: "sales by POS location", ql: `FROM sales SHOW gross_sales, orders GROUP BY pos_location_name ${W}`, why: "per-store retail sales" },
  { group: "retail", label: "sales by staff member", ql: `FROM sales SHOW gross_sales GROUP BY staff_member_name ${W}`, why: "staff performance" },
  { group: "retail", label: "sales by channel", ql: `FROM sales SHOW gross_sales, orders GROUP BY sales_channel ${W}`, why: "online vs retail split" },
];

const results = [];
for (const c of CANDIDATES) {
  try {
    const { columns, rows } = await shopifyQL(cfg, c.ql + " LIMIT 3");
    results.push({ ...c, ok: true, cols: columns.map((x) => x.name), rowCount: rows.length, sample: rows[0] || null });
    process.stdout.write("✓");
  } catch (e) {
    const reason = e instanceof ShopifyError ? e.reason : "error";
    results.push({ ...c, ok: false, reason, message: String(e?.message || e).slice(0, 220) });
    process.stdout.write(reason === "throttle" ? "~" : "✗");
  }
  // Gentle on the cost bucket — this is a probe, not a load test.
  await new Promise((r) => setTimeout(r, 350));
}
console.log("\n");

let lastGroup = null;
for (const r of results) {
  if (r.group !== lastGroup) {
    console.log(`\n── ${r.group.toUpperCase()} ${"─".repeat(Math.max(0, 60 - r.group.length))}`);
    lastGroup = r.group;
  }
  if (r.ok) {
    console.log(`  ✅ ${r.label}`);
    console.log(`     unlocks : ${r.why}`);
    console.log(`     columns : ${r.cols.join(", ")}`);
    if (r.sample) {
      const preview = Object.entries(r.sample).slice(0, 5).map(([k, v]) => `${k}=${v}`).join("  ");
      console.log(`     sample  : ${preview}`);
    } else {
      console.log(`     sample  : (query valid, no rows in this window)`);
    }
  } else {
    console.log(`  ❌ ${r.label}  [${r.reason}]`);
    console.log(`     wanted  : ${r.why}`);
    console.log(`     error   : ${r.message}`);
  }
}

const pass = results.filter((r) => r.ok);
const scopeFails = results.filter((r) => !r.ok && r.reason === "scope");
console.log(`\n${"=".repeat(64)}`);
console.log(`${pass.length}/${results.length} candidates available on this store.`);
if (scopeFails.length) {
  console.log(
    `${scopeFails.length} failed with reason "scope" — that is usually a missing access ` +
      `scope or an unsupported column name, NOT a hard limit. Check the error text: a ` +
      `"parse error" names a bad column; "access denied" means the token needs more.`,
  );
}
console.log(
  `\nAnything marked ✅ is buildable today with the credentials already configured.\n` +
    `Nothing was written to the store.`,
);
