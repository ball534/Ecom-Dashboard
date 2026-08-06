// scripts/verify-shopifyql.js
// Probes whether the configured shpat_ token can read ShopifyQL via the Admin API's
// `shopifyqlQuery` field, and across which API versions. Prints the live Sessions and
// Sales rows so you can eyeball them against the Shopify admin Analytics page.
//
// Usage:  node scripts/verify-shopifyql.js [year]
// Exit 0 = at least one API version returned data. Exit 1 = none did.

import { loadEnv } from "./_env.js";
import { resolveConfig, shopifyQL, ShopifyError } from "../api/_shopify.js";

loadEnv();
const base = await resolveConfig();
const YEAR = Number(process.argv[2] || new Date().getFullYear());
const start = `${YEAR}-01-01`;
const end = `${YEAR}-12-31`;

// Probe the pinned version first, then current GA versions (newest last so the
// "lowest that works" is easy to read off the output).
const VERSIONS = Array.from(new Set([base.version, "2025-04", "2025-07", "2025-10", "2026-01"]));

const mask = (t) => (t ? `${t.slice(0, 6)}…${t.slice(-4)} (len ${t.length})` : "(empty)");
console.log("Shopify config:");
console.log("  domain :", base.domain || "(not set)");
console.log("  token  :", mask(base.token));
console.log("  probing versions:", VERSIONS.join(", "));
console.log("");

const SALES_QL = `FROM sales SHOW gross_sales, discounts, orders, average_order_value TIMESERIES month SINCE ${start} UNTIL ${end}`;
const SESSIONS_QL = `FROM sessions SHOW sessions, conversion_rate TIMESERIES month SINCE ${start} UNTIL ${end}`;

function printTable(label, { columns, rows }) {
  console.log(`   ${label}: ${rows.length} row(s)`);
  if (!rows.length) return;
  const names = columns.map((c) => c.name);
  console.log("     " + names.join(" | "));
  for (const r of rows) {
    console.log("     " + names.map((n) => String(r[n] ?? "")).join(" | "));
  }
}

let anyWorked = false;
for (const version of VERSIONS) {
  const cfg = { ...base, version };
  console.log(`── API version ${version} ──────────────────────────────`);
  try {
    const sales = await shopifyQL(cfg, SALES_QL);
    const sessions = await shopifyQL(cfg, SESSIONS_QL);
    console.log("✅ shopifyqlQuery returned data with this token.");
    printTable("FROM sales", sales);
    printTable("FROM sessions", sessions);
    anyWorked = true;
  } catch (e) {
    const reason = e instanceof ShopifyError ? e.reason : "error";
    console.log(`❌ failed (reason: ${reason}): ${String(e.message || e).slice(0, 300)}`);
  }
  console.log("");
}

if (anyWorked) {
  console.log("→ Pin SHOPIFY_API_VERSION to the LOWEST version above that returned data.");
  process.exitCode = 0;
} else {
  console.log("→ shopifyqlQuery is not accessible for this token on any probed version.");
  console.log("  The dashboard will fall back to the Orders reconstruction for sales, and");
  console.log("  Sessions/Conversion will stay as dashes. To enable: grant read_reports /");
  console.log("  read_analytics to the custom app (Plus stores), or use a token that has it.");
  process.exitCode = 1;
}
