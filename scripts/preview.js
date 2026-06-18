// scripts/preview.js
// Prints the LIVE aggregated iORA SG numbers month-by-month, exactly as the
// /api/dashboard endpoint would return them — so you can eyeball them against the
// Shopify admin Analytics/Sales report. Usage: npm run preview [year]

import { loadEnv } from "./_env.js";
import { getConfig, fetchOrders } from "../api/_shopify.js";
import { bucketOrders, monthsWithData } from "../lib/aggregate.js";

loadEnv();
const cfg = getConfig();
const YEAR = Number(process.argv[2] || new Date().getFullYear());
const TZ = "Asia/Singapore";
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const { orders, pages, truncated } = await fetchOrders(cfg, {
  start: `${YEAR}-01-01`,
  end: `${YEAR}-12-31`,
  includeCustomer: true,
});
const m = bucketOrders(orders, { years: [YEAR], timeZone: TZ });

const f = (n) => (n == null ? "" : Number(n).toLocaleString("en-SG", { maximumFractionDigits: 2 }));
const pad = (s, w) => String(s).padStart(w);

console.log(`\niORA SG — live Shopify aggregation for ${YEAR}`);
console.log(`(${orders.length} orders over ${pages} pages${truncated ? ", TRUNCATED" : ""}; test + cancelled excluded)\n`);
const cols = ["Mo", "Revenue", "Orders", "Units", "Discounts", "Voucher", "New", "Return"];
console.log(cols.map((c, i) => pad(c, i === 0 ? 4 : 12)).join(""));
const live = monthsWithData(m.ord[YEAR]);
for (let i = 0; i < 12; i++) {
  if (!live.includes(i)) continue;
  console.log(
    [MONTHS[i], f(m.rev[YEAR][i]), f(m.ord[YEAR][i]), f(m.uni[YEAR][i]),
     f(m.dis[YEAR][i]), f(m.vou[YEAR][i]), f(m.cust[YEAR][i]), f(m.ret[YEAR][i])]
      .map((v, j) => pad(v, j === 0 ? 4 : 12)).join("")
  );
}
const sum = (a) => a.reduce((t, v) => t + (v || 0), 0);
console.log(
  ["Σ", f(sum(m.rev[YEAR])), f(sum(m.ord[YEAR])), f(sum(m.uni[YEAR])),
   f(sum(m.dis[YEAR])), f(sum(m.vou[YEAR])), f(sum(m.cust[YEAR])), f(sum(m.ret[YEAR]))]
    .map((v, j) => pad(v, j === 0 ? 4 : 12)).join("")
);
console.log("\nNote: 'Voucher' = orders that redeemed a gift card / store credit (not discount-code orders).");
