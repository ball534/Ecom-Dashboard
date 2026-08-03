// scripts/preview-insights.js
// Prints the LIVE insight sections (best sellers, discount codes, category mix,
// traffic attribution, targets) exactly as /api/insights computes them, so you can
// eyeball them against the Shopify admin — and see which SKU prefixes still need
// adding to lib/category-map.js.
//
// Usage:  node scripts/preview-insights.js [brand] [start] [end] [--probe]
//   defaults: SG, current-year-01-01, today.
//   --probe additionally tests whether ShopifyQL accepts LIMIT 1000 on the SKU pull
//   and whether a two-column GROUP BY product_variant_sku, product_type parses
//   (feeds the future product_type merge decision).

import { loadEnv } from "./_env.js";
import { getConfig, envNames, shopifyQL, ShopifyError } from "../api/_shopify.js";
import {
  INSIGHT_QUERIES,
  SKU_PULL_LIMIT,
  parseTopSkus,
  parseTopTitles,
  parseDiscountCodes,
  parseReferrers,
  parseOrderReferrers,
  parseCampaigns,
  buildCategoryMix,
} from "../lib/insights.js";
import { CATEGORY_MAP } from "../lib/category-map.js";
import { TARGETS, getTargets } from "../lib/targets.js";

loadEnv();
const args = process.argv.slice(2).filter((a) => a !== "--probe");
const probe = process.argv.includes("--probe");
const brand = (args[0] || "SG").toUpperCase();
const year = new Date().getFullYear();
const start = args[1] || `${year}-01-01`;
const end = args[2] || new Date().toISOString().slice(0, 10);
const LIMIT = 10;

const cfg = getConfig(process.env, brand);
if (!cfg.token || !cfg.domain) {
  console.log(`Brand ${brand} is not configured (no token/domain). Set ${envNames(brand).token} / ${envNames(brand).domain}.`);
  process.exit(1);
}

const f = (n) => (n == null ? "–" : Number(n).toLocaleString("en-SG", { maximumFractionDigits: 2 }));
const pad = (s, w) => String(s ?? "–").padEnd(w);
const padr = (s, w) => String(s ?? "–").padStart(w);

function table(title, rows, cols) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(2, 60 - title.length))}`);
  if (!rows || !rows.length) return console.log("   (no data)");
  console.log("   " + cols.map(([h, w]) => (w > 0 ? pad(h, w) : padr(h, -w))).join("  "));
  for (const r of rows) {
    console.log("   " + cols.map(([h, w, k, fmt]) => {
      const v = fmt ? fmt(r[k]) : r[k];
      return w > 0 ? pad(v, w) : padr(v, -w);
    }).join("  "));
  }
}

console.log(`Insights preview — ${brand} (${cfg.domain}) ${start} → ${end}`);

const results = await Promise.allSettled(
  INSIGHT_QUERIES.map((spec) => shopifyQL(cfg, spec.build(start, end, LIMIT))),
);
const rowsByKey = {};
INSIGHT_QUERIES.forEach((spec, i) => {
  const r = results[i];
  if (r.status === "fulfilled") rowsByKey[spec.key] = r.value.rows;
  else {
    rowsByKey[spec.key] = null;
    const e = r.reason;
    console.log(`\n⚠ ${spec.key} unavailable: ${e instanceof ShopifyError ? e.reason : ""} ${String(e?.message || e).slice(0, 160)}`);
  }
});

if (rowsByKey.skuSales) {
  table(`Top ${LIMIT} SKUs (by units)`, parseTopSkus(rowsByKey.skuSales, LIMIT), [
    ["SKU", 26, "sku"], ["Units", -7, "qty", f], ["Gross", -12, "gross", f], ["Net", -12, "net", f],
  ]);
}
if (rowsByKey.titleSales) {
  table(`Top ${LIMIT} products (by units)`, parseTopTitles(rowsByKey.titleSales, LIMIT), [
    ["Product", 34, "title"], ["Units", -7, "qty", f], ["Gross", -12, "gross", f], ["Net", -12, "net", f],
  ]);
}
if (rowsByKey.discountCodes) {
  const d = parseDiscountCodes(rowsByKey.discountCodes);
  table("Discount codes (by amount given)", d.codes, [
    ["Code", 24, "code"], ["Orders", -7, "orders", f], ["Gross", -12, "gross", f], ["Discount", -10, "discount", f],
  ]);
  if (d.others) console.log(`   … +${d.others.count} more codes: ${f(d.others.orders)} orders, ${f(d.others.gross)} gross, ${f(d.others.discount)} discount`);
  if (d.noCode) console.log(`   (no code: ${f(d.noCode.orders)} orders, ${f(d.noCode.gross)} gross)`);
}
if (rowsByKey.skuSales) {
  const mix = buildCategoryMix(rowsByKey.skuSales, CATEGORY_MAP);
  mix.truncated = rowsByKey.skuSales.length >= SKU_PULL_LIMIT;
  table("Category mix (SKU-prefix map)", mix.rows, [
    ["Category", 24, "category"], ["Gross", -12, "gross", f], ["Units", -8, "qty", f],
    ["Share", -7, "share", (v) => (v * 100).toFixed(1) + "%"],
  ]);
  const total = mix.rows.reduce((t, r) => t + r.gross, 0);
  console.log(`   Σ gross ${f(total)}${mix.truncated ? "  ⚠ SKU pull hit its row limit — mix is approximate" : ""}`);
  if (mix.unmapped.length) {
    table("UNMAPPED PREFIXES (add these to lib/category-map.js)", mix.unmapped, [
      ["Prefix", 8, "prefix"], ["Gross", -12, "gross", f], ["Units", -8, "qty", f],
    ]);
  }
}
if (rowsByKey.referrers) {
  table("Sessions by referrer", parseReferrers(rowsByKey.referrers), [
    ["Source", 16, "source", (v) => v ?? "(direct/unknown)"], ["Sessions", -10, "sessions", f],
  ]);
}
if (rowsByKey.orderReferrers) {
  table("Orders by referrer", parseOrderReferrers(rowsByKey.orderReferrers), [
    ["Source", 16, "source", (v) => v ?? "(unattributed)"], ["Orders", -7, "orders", f], ["Sales", -12, "sales", f],
  ]);
}
if (rowsByKey.campaigns) {
  table(`Top ${LIMIT} UTM campaigns (sessions)`, parseCampaigns(rowsByKey.campaigns, LIMIT), [
    ["Campaign", 44, "campaign"], ["Sessions", -10, "sessions", f],
  ]);
}

const years = [];
for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) years.push(y);
const tgt = getTargets(TARGETS, brand, years);
if (tgt) {
  for (const [y, arr] of Object.entries(tgt)) {
    console.log(`\n── Targets ${y} ${"─".repeat(46)}\n   ${arr.map((v) => f(v)).join("  ")}`);
  }
} else {
  console.log(`\n(no targets defined for ${brand} in lib/targets.js)`);
}

if (probe) {
  console.log("\n── Probes ──────────────────────────────────────────────────");
  console.log(`   SKU pull row count: ${rowsByKey.skuSales ? rowsByKey.skuSales.length : "n/a"} (SKU_PULL_LIMIT=${SKU_PULL_LIMIT}${rowsByKey.skuSales && rowsByKey.skuSales.length >= SKU_PULL_LIMIT ? " — HIT, consider raising/bulk" : " — ok"})`);
  try {
    const { rows } = await shopifyQL(cfg, `FROM sales SHOW gross_sales GROUP BY product_variant_sku, product_type LIMIT 5 SINCE ${start} UNTIL ${end}`);
    console.log(`   two-column GROUP BY sku, product_type: ✅ parses (${rows.length} rows) — product_type merge is feasible later`);
  } catch (e) {
    console.log(`   two-column GROUP BY sku, product_type: ❌ ${String(e?.message || e).slice(0, 120)}`);
  }
}
