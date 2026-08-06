// scripts/preview-insights.js
// Prints the LIVE insight sections (best sellers, discount codes + monthly rows,
// category mix, traffic attribution + monthly referrers + landing pages, funnel,
// voucher report, targets) exactly as /api/insights computes them, so you can
// eyeball them against the Shopify admin — including how much of the range Shopify
// has no product_type for (the Category Mix panel's only input).
//
// Usage:  node scripts/preview-insights.js [brand] [start] [end] [--probe]
//   defaults: SG, current-year-01-01, today.
//   --probe additionally tests whether ShopifyQL accepts LIMIT 1000 on the SKU pull
//   and whether a two-column GROUP BY product_variant_sku, product_type parses
//   (feeds the future product_type merge decision).

import { loadEnv } from "./_env.js";
import { resolveConfig, envNames, envSuffix, shopifyQL, ShopifyError } from "../api/_shopify.js";
import {
  INSIGHT_QUERIES,
  SKU_PULL_LIMIT,
  parseTopSkus,
  parseTopTitles,
  parseDiscountCodes,
  parseDiscountMonthly,
  parseReferrers,
  parseOrderReferrers,
  parseCampaigns,
  parseFunnel,
  parseTrafficMonthly,
  parseLandingPages,
  buildVoucherReport,
  parseCategoryMix,
  parseDiscountTerms,
  PRODUCT_TYPE_LIMIT,
} from "../lib/insights.js";
import { TARGETS, getTargets } from "../lib/targets.js";

loadEnv();
const args = process.argv.slice(2).filter((a) => a !== "--probe");
const probe = process.argv.includes("--probe");
const brand = (args[0] || "SG").toUpperCase();
const year = new Date().getFullYear();
const start = args[1] || `${year}-01-01`;
const end = args[2] || new Date().toISOString().slice(0, 10);
const LIMIT = 10;

const cfg = await resolveConfig(process.env, brand);
if (cfg.tokenError) {
  console.log(`Brand ${brand}: could not mint an access token — ${cfg.tokenError.message}`);
  process.exit(1);
}
if (!cfg.token || !cfg.domain) {
  console.log(`Brand ${brand} is not configured. Set ${envNames(brand).domain} plus either ` +
    `${envNames(brand).token} or CLIENT_${envSuffix(brand)} / SECRET_${envSuffix(brand)}.`);
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
if (rowsByKey.productTypes) {
  const mix = parseCategoryMix(rowsByKey.productTypes);
  if (!mix) {
    console.log("\n   Category mix: Shopify has no product_type on any sales in this range — " +
      "the panel shows an empty state (nothing is inferred from SKU naming).");
  } else {
    mix.truncated = rowsByKey.productTypes.length >= PRODUCT_TYPE_LIMIT;
    table("Category mix (live product_type)", mix.rows, [
      ["Category", 24, "category"], ["Gross", -12, "gross", f], ["Units", -8, "qty", f],
      ["Share", -7, "share", (v) => (v * 100).toFixed(1) + "%"],
    ]);
    const total = mix.rows.reduce((t, r) => t + r.gross, 0);
    console.log(`   Σ classified gross ${f(total)}${mix.truncated ? "  ⚠ product_type pull hit its row limit" : ""}`);
    if (mix.unclassified) {
      console.log(`   ⚠ no product_type set in Shopify for ${f(mix.unclassified.gross)} gross / ` +
        `${f(mix.unclassified.qty)} units — excluded from the mix, never guessed.`);
    }
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
if (rowsByKey.funnel) {
  const fun = parseFunnel(rowsByKey.funnel) || {};
  for (const [y, d] of Object.entries(fun)) {
    console.log(`\n── Funnel ${y} (cart adds / reached checkout / completed) ${"─".repeat(12)}`);
    console.log("   " + d.cart.map((c, i) => (c == null ? "–" : `${i + 1}:${f(c)}/${f(d.checkout[i])}/${f(d.converted[i])}`)).filter((s) => s !== "–").join("  "));
  }
}
if (rowsByKey.discountMonthly) {
  const dm = parseDiscountMonthly(rowsByKey.discountMonthly) || {};
  for (const [y, months] of Object.entries(dm)) {
    const last = months.reduce((t, m, i) => (m ? i : t), -1);
    if (last < 0) continue;
    table(`Discount rows ${y}-${String(last + 1).padStart(2, "0")} (latest month with rows)`,
      months[last].map(([name, rev, orders, given, type]) => ({ name, rev, orders, given, type })), [
      ["Name", 24, "name"], ["Revenue", -12, "rev", f], ["Orders", -7, "orders", f],
      ["Given", -10, "given", f], ["Type", 5, "type"],
    ]);
  }
}
if (rowsByKey.trafficMonthly) {
  const by = parseTrafficMonthly(rowsByKey.trafficMonthly) || {};
  for (const [y, d] of Object.entries(by)) {
    table(`Sessions by referrer name ${y} (top + Other)`, d.sources.map(([name, sessions]) => ({ name, sessions })), [
      ["Referrer", 20, "name"], ["Sessions", -10, "sessions", f],
    ]);
    console.log(`   months with data: ${Object.keys(d.monthly).map((m) => +m + 1).join(", ")}`);
  }
}
if (rowsByKey.landing) {
  table("Top landing pages (sessions)", parseLandingPages(rowsByKey.landing).map(([path, sessions]) => ({ path, sessions })), [
    ["Path", 44, "path"], ["Sessions", -10, "sessions", f],
  ]);
}
if (rowsByKey.discountCodes) {
  const v = buildVoucherReport(rowsByKey.discountCodes, rowsByKey.discountMonthly);
  if (v) {
    console.log(`\n── Voucher report — store actual ${f(v.store.actual)}, AOV ${f(v.store.aov)} ${"─".repeat(8)}`);
    table(`Voucher rows (top ${LIMIT} of ${v.rows.length} by sales)`, v.rows.slice(0, LIMIT), [
      ["Title", 24, "title"], ["Date", 12, "date"], ["Sales", -12, "sales", f], ["AOV", -8, "aov", f],
      ["Disc", -10, "disc", f], ["Disc%", -6, "discPct", f], ["Redeemed", -9, "redeemed", f],
    ]);
  }
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
  console.log(`   SKU pull row count: ${rowsByKey.skuSales ? rowsByKey.skuSales.length : "n/a"}`);
  console.log(`   product_type row count: ${rowsByKey.productTypes ? rowsByKey.productTypes.length : "n/a"} (limit ${PRODUCT_TYPE_LIMIT})`);
  try {
    const { rows } = await shopifyQL(cfg, `FROM sales SHOW gross_sales GROUP BY product_variant_sku, product_type LIMIT 5 SINCE ${start} UNTIL ${end}`);
    console.log(`   two-column GROUP BY sku, product_type: ✅ parses (${rows.length} rows) — product_type merge is feasible later`);
  } catch (e) {
    console.log(`   two-column GROUP BY sku, product_type: ❌ ${String(e?.message || e).slice(0, 120)}`);
  }
}
