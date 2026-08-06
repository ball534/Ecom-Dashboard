// scripts/preview-ads.js
// Calls api/ads.js exactly as Vercel would and prints what the Ads tab will show, so a
// new Meta/Google/TikTok credential set can be verified from a terminal before deploying.
//
//   npm run preview-ads              # brand SG, current year
//   npm run preview-ads MY 2026
//
// A platform with no credentials prints "not-configured" — that is a pass, not a failure:
// it is exactly what makes the tab show an honest blank instead of an error.

import { loadEnv } from "./_env.js";
import handler from "../api/ads.js";

loadEnv();

const BRAND = (process.argv[2] || "SG").toUpperCase();
const YEAR = Number(process.argv[3] || new Date().getFullYear());
const today = new Date().toISOString().slice(0, 10);
const end = YEAR === new Date().getFullYear() ? today : `${YEAR}-12-31`;

// Minimal req/res doubles — the handler only uses req.query, res.setHeader/status/json.
const res = {
  headers: {},
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.code = c; return this; },
  json(body) { this.body = body; return this; },
};
await handler({ query: { brand: BRAND, start: `${YEAR}-01-01`, end } }, res);

const { platforms, campaigns, meta } = res.body;
const f = (n) => (n == null ? "—" : Number(n).toLocaleString("en-SG", { maximumFractionDigits: 2 }));
const pad = (s, w) => String(s).padStart(w);

console.log(`\nAds — brand ${BRAND}, ${meta.range.start} → ${meta.range.end} (year ${meta.range.year})`);
console.log(`HTTP ${res.code} · live: ${meta.live} · cache: ${res.headers["Cache-Control"]}`);
if (meta.range.clamped) console.log("! range clamped to the end year (the tab renders one year at a time)");
console.log(`store currency ${meta.storeCurrency}; accounts report ${meta.currencies.join(", ") || "—"}` +
  (meta.currencyMismatch ? "  ← MISMATCH: figures are not converted" : ""));

for (const key of ["fb", "google", "tiktok"]) {
  const m = meta.platforms[key] || {};
  const label = { fb: "Meta", google: "Google", tiktok: "TikTok" }[key];
  console.log(`\n── ${label}`);
  if (m.ok === false) {
    console.log(`   ${m.reason}: ${m.message}`);
    continue;
  }
  console.log(`   accounts ${(m.accounts || []).join(", ")} · ${m.rows} daily rows · currency ${m.currency || "—"}`);
  (m.notes || []).forEach((n) => console.log(`   note: ${n}`));
  const pf = platforms[key];
  if (!pf) { console.log("   connected, but no rows in this window"); continue; }
  console.log(["Mo", "Spend", "Impr", "Clicks", "Purch", "Revenue", "ROAS"]
    .map((c, i) => pad(c, i === 0 ? 5 : 12)).join(""));
  pf.months.forEach((mn, i) => {
    const sp = pf.spend[i], rv = pf.rev ? pf.rev[i] : null;
    console.log([mn, f(sp), f(pf.impr[i]), f(pf.clicks[i]),
      f(pf.purch ? pf.purch[i] : null), f(rv),
      sp && rv != null ? (rv / sp).toFixed(2) + "×" : "—"]
      .map((v, j) => pad(v, j === 0 ? 5 : 12)).join(""));
  });
  console.log(`   weeks: ${pf.weekly.length} (first ${pf.weekly[0]?.w || "—"})`);
  const cs = campaigns[key] || [];
  console.log(`   campaigns: ${cs.length}${cs.length ? ` · top: ${cs[0].n} (${f(cs[0].sp)} spend)` : ""}`);
}
console.log("");
