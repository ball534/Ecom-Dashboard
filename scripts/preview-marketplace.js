// scripts/preview-marketplace.js
// Calls api/marketplace.js exactly as Vercel would and prints the Channel Mix rows and
// marketplace voucher rows the dashboard will render — the way to verify a Shopee/Lazada
// authorization before deploying it.
//
//   npm run preview-marketplace              # brand SG, current year to date
//   npm run preview-marketplace MY 2026
//
// "not-configured" is a pass: it is what makes the Channel Mix panel stay blank instead
// of claiming a split it cannot see.

import { loadEnv } from "./_env.js";
import handler from "../api/marketplace.js";

loadEnv();

const BRAND = (process.argv[2] || "SG").toUpperCase();
const YEAR = Number(process.argv[3] || new Date().getFullYear());
const today = new Date().toISOString().slice(0, 10);
const end = YEAR === new Date().getFullYear() ? today : `${YEAR}-12-31`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const res = {
  headers: {},
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.code = c; return this; },
  json(body) { this.body = body; return this; },
};
await handler({ query: { brand: BRAND, start: `${YEAR}-01-01`, end } }, res);

const { channels, vouchers, meta } = res.body;
const f = (n) => (n == null ? "—" : Number(n).toLocaleString("en-SG", { maximumFractionDigits: 2 }));
const pad = (s, w) => String(s).padStart(w);

console.log(`\nMarketplaces — brand ${BRAND}, ${meta.range.start} → ${meta.range.end}`);
console.log(`HTTP ${res.code} · live: ${meta.live} · cache: ${res.headers["Cache-Control"]}`);
console.log(`token store: ${meta.tokenStore}${meta.tokenStore !== "redis" ? "  ← set TOKEN_STORE_URL/_TOKEN before relying on this in production (refresh tokens rotate)" : ""}`);

for (const ch of ["Shopee", "Lazada"]) {
  const m = meta.channels[ch] || {};
  console.log(`\n── ${ch}`);
  if (m.ok === false) {
    console.log(`   ${m.reason}: ${m.message}`);
    continue;
  }
  console.log(`   ${m.orders} orders pulled, ${m.excluded} excluded as cancelled/unpaid`);
  (m.notes || []).forEach((n) => console.log(`   note: ${n}`));
  const c = channels[ch];
  const rev = (c && c.revenue) || {};
  for (const y of Object.keys(rev)) {
    console.log(`   ${y}: ` + rev[y].map((v, i) => (v == null ? "" : `${MONTHS[i]} ${f(v)}`)).filter(Boolean).join("  "));
  }
  if (c && c.totals) console.log(`   total ${f(c.totals.actual)} over ${c.totals.orders} orders (AOV ${f(c.totals.aov)})`);
}

console.log(`\n── Marketplace vouchers (${vouchers ? vouchers.length : 0})`);
(vouchers || []).slice(0, 15).forEach((v) => {
  console.log(["  " + v.ch, v.title, v.date, f(v.sales), `${v.redeemed} redemptions`, `disc ${f(v.disc)}`]
    .map((s, i) => (i === 0 ? pad(s, 10) : " " + s)).join(""));
});
console.log(`\n${meta.basis}\n`);
