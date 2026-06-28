// scripts/preview.js
// Prints the LIVE iORA SG numbers month-by-month, exactly as /api/dashboard returns
// them, so you can eyeball them against the Shopify admin Analytics page. Sales +
// Sessions come from ShopifyQL (the admin's own engine); Units/Voucher/New/Returning
// from the Orders API. Usage: npm run preview [year]

import { loadEnv } from "./_env.js";
import { getConfig, fetchOrders, shopifyQL, ShopifyError } from "../api/_shopify.js";
import { bucketOrders, monthsWithData } from "../lib/aggregate.js";
import { buildSalesQL, buildSessionsQL, bucketSales, bucketSessions } from "../lib/shopifyql.js";

loadEnv();
const cfg = getConfig();
const YEAR = Number(process.argv[2] || new Date().getFullYear());
const TZ = "Asia/Singapore";
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const start = `${YEAR}-01-01`;
const end = `${YEAR}-12-31`;

const { orders, pages, truncated } = await fetchOrders(cfg, { start, end, includeCustomer: true });
const m = bucketOrders(orders, { years: [YEAR], timeZone: TZ });

// Overlay the exact ShopifyQL figures (same as api/dashboard.js).
let salesSource = "reconstructed (Orders fallback)";
let sessionsLive = false;
try {
  const sales = bucketSales((await shopifyQL(cfg, buildSalesQL(start, end))).rows, [YEAR]);
  m.rev[YEAR] = sales.rev[YEAR];
  m.dis[YEAR] = sales.dis[YEAR];
  m.ord[YEAR] = sales.ord[YEAR];
  salesSource = "ShopifyQL (exact)";
} catch (e) {
  console.warn("⚠ ShopifyQL sales unavailable:", e instanceof ShopifyError ? e.reason : e.message);
}
try {
  const sess = bucketSessions((await shopifyQL(cfg, buildSessionsQL(start, end))).rows, [YEAR]);
  m.ses = sess.ses;
  m.conversion = sess.conversion;
  sessionsLive = true;
} catch (e) {
  console.warn("⚠ ShopifyQL sessions unavailable:", e instanceof ShopifyError ? e.reason : e.message);
}

const f = (n) => (n == null ? "" : Number(n).toLocaleString("en-SG", { maximumFractionDigits: 2 }));
const fp = (n) => (n == null ? "" : (n * 100).toFixed(2) + "%");
const pad = (s, w) => String(s).padStart(w);

console.log(`\niORA SG — live numbers for ${YEAR}`);
console.log(`Sales source: ${salesSource}; sessions live: ${sessionsLive}`);
console.log(`(${orders.length} orders over ${pages} pages${truncated ? ", TRUNCATED" : ""}; test orders excluded)\n`);
const cols = ["Mo","Revenue","Orders","Units","Discounts","Voucher","New","Return","Sessions","Conv"];
console.log(cols.map((c, i) => pad(c, i === 0 ? 4 : 12)).join(""));
const live = monthsWithData(m.ord[YEAR]);
for (let i = 0; i < 12; i++) {
  if (!live.includes(i)) continue;
  console.log(
    [MONTHS[i], f(m.rev[YEAR][i]), f(m.ord[YEAR][i]), f(m.uni[YEAR][i]),
     f(m.dis[YEAR][i]), f(m.vou[YEAR][i]), f(m.cust[YEAR][i]), f(m.ret[YEAR][i]),
     f(m.ses?.[YEAR]?.[i]), fp(m.conversion?.[YEAR]?.[i])]
      .map((v, j) => pad(v, j === 0 ? 4 : 12)).join("")
  );
}
const sum = (a) => (a || []).reduce((t, v) => t + (v || 0), 0);
console.log(
  ["Σ", f(sum(m.rev[YEAR])), f(sum(m.ord[YEAR])), f(sum(m.uni[YEAR])),
   f(sum(m.dis[YEAR])), f(sum(m.vou[YEAR])), f(sum(m.cust[YEAR])), f(sum(m.ret[YEAR])),
   f(sum(m.ses?.[YEAR])), ""]
    .map((v, j) => pad(v, j === 0 ? 4 : 12)).join("")
);
console.log("\nNote: 'Voucher' = orders that redeemed a gift card / store credit (not discount-code orders).");
console.log("'Conv' = ShopifyQL conversion_rate (per month).");
