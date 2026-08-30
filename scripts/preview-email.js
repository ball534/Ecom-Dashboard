// scripts/preview-email.js
// Calls api/email.js exactly as Vercel would and prints what the Dotdigital card will
// show, so a new Dotdigital or Klaviyo credential can be verified from a terminal
// before deploying.
//
//   npm run preview-email              # every brand, current year — also RECONCILES
//   npm run preview-email SG 2026      # one brand
//
// A brand with no credentials prints "not-configured" — that is a pass, not a failure:
// it is exactly what makes the card show an honest blank instead of an error.
//
// Run with no brand and it does the job `npm run meta-accounts` does for ad accounts:
// checks the mapping itself. One email account serving two stores would double-count
// every send in SGALL / MYALL / GROUP, and no single-brand request can see it — so the
// sweep compares account ids across all eight brands and EXITS NON-ZERO on a clash,
// on a store whose credentials cannot be read, and on a currency that does not match
// the store's own.

import { loadEnv } from "./_env.js";
import handler from "../api/email.js";
import { LIVE_BRANDS } from "../lib/env-keys.js";

loadEnv();

const ARG = (process.argv[2] || "").toUpperCase();
const BRANDS = ARG ? [ARG] : LIVE_BRANDS;
const YEAR = Number(process.argv[3] || new Date().getFullYear());
const today = new Date().toISOString().slice(0, 10);
const end = YEAR === new Date().getFullYear() ? today : `${YEAR}-12-31`;

const f = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-SG", { maximumFractionDigits: 2 });
const pct = (n) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
const pad = (s, w) => String(s).padStart(w);

async function pull(brand) {
  const res = {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ query: { brand, start: `${YEAR}-01-01`, end } }, res);
  return res;
}

const seen = new Map(); // account id -> [brand, …]
const problems = [];

for (const brand of BRANDS) {
  const res = await pull(brand);
  const { campaigns, meta } = res.body;

  console.log(`\n══ ${brand} · ${meta.provider} · ${meta.range.start} → ${meta.range.end}`);
  console.log(`   HTTP ${res.code} · live: ${meta.live} · cache: ${res.headers["Cache-Control"]}`);

  if (meta.ok !== true) {
    console.log(`   ${meta.reason}: ${meta.message}`);
    // Only a genuine failure is a problem. "not-configured" is a deliberate blank.
    if (meta.reason !== "not-configured") problems.push(`${brand}: ${meta.reason} — ${meta.message}`);
    continue;
  }

  const id = meta.account?.id;
  console.log(
    `   account ${id || "—"}  (${meta.account?.label || "—"})` +
      (meta.account?.shared ? `  · shared, split by ${meta.account.filter || "NOTHING"}` : ""),
  );
  console.log(
    `   store currency ${meta.storeCurrency}; account reports ${meta.currency || "—"}` +
      (meta.currencyMismatch ? "  ← MISMATCH: figures are not converted" : ""),
  );
  if (meta.stats) {
    console.log(
      `   ${meta.stats.campaigns} sent campaigns · ${meta.stats.fetched} fetched this run · ` +
        `${meta.stats.cached} in cache (${meta.tokenStore})`,
    );
  }
  (meta.notes || []).forEach((n) => console.log(`   note: ${n}`));

  if (id) {
    if (!seen.has(id)) seen.set(id, []);
    seen.get(id).push(brand);
  }
  if (meta.currencyMismatch) {
    problems.push(`${brand}: account reports ${meta.currency}, store trades in ${meta.storeCurrency}`);
  }

  if (!campaigns) {
    console.log("   connected, but no sends in this window");
    continue;
  }

  // The monthly roll-up exactly as dotdTable() will bucket it.
  const B = new Map();
  for (const c of campaigns) {
    const k = c.s.slice(0, 7);
    const b = B.get(k) || { dl: 0, op: 0, cl: 0, rv: null, or: null };
    b.dl += c.dl; b.op += c.op; b.cl += c.cl;
    if (c.rv != null) b.rv = (b.rv || 0) + c.rv;
    if (c.or != null) b.or = (b.or || 0) + c.or;
    B.set(k, b);
  }
  console.log(
    ["Month", "Sends", "Delivered", "Opened", "%Open", "Clicks", "%Click", "Revenue", "Orders"]
      .map((c, i) => pad(c, i === 0 ? 8 : 11)).join(""),
  );
  for (const [k, b] of [...B.entries()].sort()) {
    const n = campaigns.filter((c) => c.s.slice(0, 7) === k).length;
    console.log(
      [k, n, f(b.dl), f(b.op), pct(b.dl ? b.op / b.dl : null), f(b.cl),
        pct(b.dl ? b.cl / b.dl : null), f(b.rv), f(b.or)]
        .map((v, i) => pad(v, i === 0 ? 8 : 11)).join(""),
    );
  }
}

if (!ARG) {
  console.log("\n══ mapping check");
  for (const [id, brands] of seen) {
    if (brands.length > 1) {
      problems.push(
        `${brands.join(" and ")} resolve to the same account AND filter (${id}) — ` +
          `they would show each other's sends, and the roll-ups would count them twice`,
      );
    }
  }
  if (problems.length) {
    problems.forEach((p) => console.log(`   ✗ ${p}`));
    console.log(`\n${problems.length} problem(s) that would misreport. Fix before deploying.`);
    process.exit(1);
  }
  console.log(
    `   ✓ ${seen.size} configured store(s), each on its own account+filter, currencies consistent`,
  );
}
