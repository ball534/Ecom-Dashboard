// scripts/probe-columns.js
// Discovers the REAL column names in each ShopifyQL dataset, from the live store.
//
// ShopifyQL has no `SHOW *` and no introspection, and shopify.dev renders its schema
// pages client-side (so they can't be scraped reliably). But the parser is a perfect
// oracle: ask for a batch of candidate columns and the parse error names EVERY invalid
// one. Whatever it doesn't name is real. One query therefore tests a whole batch.
//
// Usage:  node scripts/probe-columns.js [brand] [dataset]
//   no dataset  → probe them all
//
// READ-ONLY: every query is `LIMIT 1` over a one-month window, and most fail to parse
// (which costs nothing). Output is a verified column list per dataset — paste it into
// lib/insights.js and build against it.

import { loadEnv } from "./_env.js";
import { resolveConfig, envNames, shopifyQL, ShopifyError } from "../api/_shopify.js";

loadEnv();
const brand = (process.argv[2] || "SG").toUpperCase();
const only = process.argv[3];
const cfg = await resolveConfig(process.env, brand);
if (!cfg.token || !cfg.domain) {
  console.error(`No credentials for "${brand}" — set ${envNames(brand).domain} / ${envNames(brand).token}.`);
  process.exit(1);
}

const W = "SINCE 2026-07-01 UNTIL 2026-07-31";
const BATCH = 8; // small enough that one bad name can't mask others in the error text

// Candidates come from Shopify's own schema descriptions plus the naming conventions
// already proven on this store (snake_case, `_name` suffix for dimensions).
const CANDIDATES = {
  sales: [
    "total_sales", "gross_sales", "net_sales", "orders", "discounts", "returns", "taxes",
    "shipping_charges", "quantity_ordered", "net_items_sold", "average_order_value",
    "gift_card_sales", "gift_card_discounts", "customer_type", "sales_channel",
    "billing_country", "billing_region", "billing_city", "shipping_country",
    "shipping_region", "shipping_city", "product_title", "product_type", "product_vendor",
    "vendor", "product_variant_sku", "product_variant_title", "product_variant_compare_at_price",
    "discount_code", "order_name", "order_id", "pos_location_name", "staff_member_name",
    "order_referrer_source", "referring_channel", "api_client_name",
  ],
  returns: [
    "returned_quantity", "returned_items", "return_rate", "returns", "refunded_amount",
    "refund_amount", "total_refunds", "return_status", "return_reason", "reason",
    "return_reason_name", "returns_app_name", "return_app_name", "staff_member_name",
    "product_title", "product_variant_sku", "order_name", "returned_orders",
  ],
  profitability: [
    "revenue", "total_revenue", "net_revenue", "gross_sales", "net_sales",
    "cost_of_goods_sold", "cogs", "total_cost", "gross_profit", "profit", "gross_margin",
    "margin", "shipping_cost", "shipping_costs", "fulfillment_cost", "fulfillment_costs",
    "duties", "import_taxes", "sales_taxes", "order_name", "product_title",
  ],
  customers: [
    "customers", "customer_count", "new_customers", "returning_customers",
    "lifetime_spend", "lifetime_value", "total_spend", "amount_spent", "order_count",
    "orders", "average_spend_per_order", "average_order_value", "days_since_last_order",
    "first_order_date", "last_order_date", "customer_name", "customer_id", "customer_email",
  ],
  inventory: [
    "days_out_of_stock", "days_in_stock", "sell_through_rate", "units_sold",
    "ending_quantity", "ending_inventory_units", "starting_inventory_units",
    "inventory_value", "ending_inventory_value", "days_of_inventory_remaining",
    "average_inventory_sold_per_day", "product_title", "product_variant_sku",
    "product_type", "location_name",
  ],
  sessions: [
    "sessions", "conversion_rate", "page_views", "bounce_rate", "sessions_with_cart_additions",
    "sessions_that_reached_checkout", "sessions_that_completed_checkout", "referrer_source",
    "referrer_name", "utm_campaign", "landing_page_path", "device", "device_type",
    "device_category", "browser", "operating_system", "country", "visitor_country",
    "location_country", "region", "city", "first_time_visitor", "returning_visitor",
  ],
  fulfillments: [
    "orders_fulfilled", "fulfillments", "time_to_fulfillment", "fulfillment_time",
    "time_to_delivery", "delivery_time", "average_time_to_fulfillment", "location_name",
    "delivery_method", "tracking_company", "order_name",
  ],
  discounts: [
    "discounted_orders", "discount_amount", "discounts", "orders",
    "product_discounts", "order_discounts", "shipping_discounts", "app_discounts",
    "discount_code", "discount_type", "discount_title",
  ],
  gift_cards: [
    "gift_cards_issued", "gift_cards_redeemed", "issued_amount", "redeemed_amount",
    "gift_card_sales", "starting_balance", "ending_balance", "adjustments",
    "gift_card_code", "order_name",
  ],
  search_queries: [
    "search_query_volume", "searches", "search_volume", "total_searches", "queries",
    "result_clicks", "clicks", "search_query", "query", "clicked",
  ],
  campaign_sales: [
    "orders", "total_sales", "gross_sales", "average_order_value",
    "first_click_orders", "last_click_orders", "linear_orders",
    "campaign_name", "campaign", "utm_campaign", "utm_source", "utm_medium",
  ],
};

const rx = /Column '([^']+)' not found/g;
// These errors mean the column EXISTS but was used wrongly (metric in GROUP BY, etc.) —
// so they are evidence of a real column, not a missing one.
const existsButMisused = /'([^']+)' is a metric|Non Selectable Dimension: '([^']+)'/g;

async function probeBatch(ds, names) {
  const ql = `FROM ${ds} SHOW ${names.join(", ")} ${W} LIMIT 1`;
  try {
    await shopifyQL(cfg, ql);
    return { valid: [...names], invalid: [] };
  } catch (e) {
    const msg = String(e?.message || e);
    if (!(e instanceof ShopifyError) || !/not found|is a metric|Non Selectable/i.test(msg)) {
      return { valid: [], invalid: [], error: msg.slice(0, 200) };
    }
    const invalid = new Set();
    let m;
    rx.lastIndex = 0;
    while ((m = rx.exec(msg))) invalid.add(m[1]);
    existsButMisused.lastIndex = 0;
    while ((m = existsButMisused.exec(msg))) invalid.delete(m[1] || m[2]);
    return { valid: names.filter((n) => !invalid.has(n)), invalid: [...invalid] };
  }
}

const datasets = only ? [only] : Object.keys(CANDIDATES);
console.log(`Discovering real columns on ${cfg.domain} (${cfg.version})\n`);

for (const ds of datasets) {
  const names = CANDIDATES[ds];
  if (!names) { console.log(`(no candidate list for "${ds}")`); continue; }
  const valid = [];
  const invalid = [];
  let hardError = null;
  for (let i = 0; i < names.length; i += BATCH) {
    const r = await probeBatch(ds, names.slice(i, i + BATCH));
    if (r.error) { hardError = r.error; break; }
    valid.push(...r.valid);
    invalid.push(...r.invalid);
    await new Promise((res) => setTimeout(res, 300));
  }
  console.log(`── FROM ${ds} ${"─".repeat(Math.max(0, 52 - ds.length))}`);
  if (hardError) {
    console.log(`   dataset unavailable: ${hardError}\n`);
    continue;
  }
  console.log(`   ✅ real columns (${valid.length}): ${valid.join(", ") || "(none of the candidates)"}`);
  console.log(`   ·  not columns (${invalid.length}): ${invalid.join(", ")}\n`);
}
console.log("Done. Every ✅ name above is confirmed against the live store.");
