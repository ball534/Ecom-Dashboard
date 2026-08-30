// scripts/email-discover.js
// Reconnaissance for a SHARED email account: shows what is actually in it, so the
// brand mapping can be written from ids rather than guessed from campaign names.
//
//   npm run email-discover              # this year
//   npm run email-discover 2026
//   npm run email-discover 2026 --books # also resolve address books (one call per
//                                       # campaign — slow, but cached for the pull)
//
// IORA Group runs one Dotdigital account for iORA, SANS & SANS and TRT across both
// markets, and one Klaviyo account for both MONOLOQ stores. Neither API tags a send
// with a brand, so /api/email splits them on explicit ids — a from-address or an
// address book for Dotdigital, an audience for Klaviyo. This script lists the
// candidates with enough context to tell which one separates the brands cleanly, and
// prints a paste-ready block for .env.
//
// It reads. It never writes, and never guesses a mapping for you: which id belongs to
// which brand is a decision, and a wrong one silently moves revenue between brands.

import { loadEnv } from "./_env.js";
import {
  dotdigitalConfig,
  dotdigitalAccountInfo,
  listSentCampaigns,
  campaignAddressBooks,
} from "../lib/email-dotdigital.js";
import { klaviyoConfig } from "../lib/email-klaviyo.js";
import { requestJSON, settledPool, deadline } from "../lib/http.js";

loadEnv();

const args = process.argv.slice(2);
const WITH_BOOKS = args.includes("--books");
const YEAR = Number(args.find((a) => /^\d{4}$/.test(a)) || new Date().getFullYear());
const START = `${YEAR}-01-01`;
const END = YEAR === new Date().getFullYear() ? new Date().toISOString().slice(0, 10) : `${YEAR}-12-31`;

const pad = (s, w) => String(s).padEnd(w);
const num = (n) => Number(n).toLocaleString("en-SG");

// The six Dotdigital stores and the two Klaviyo ones, in the order .env lists them.
const DD_STORES = ["IORASG", "IORAMY", "TRTSG", "TRTMY", "SANSSG", "SANSMY"];
const KL_STORES = ["MONOSG", "MONOMY"];

/* ── Dotdigital ────────────────────────────────────────────────────────────────── */

async function dotdigital() {
  // Brand SG resolves the shared DOTDIGITAL_USER/_PASS like any other store.
  const cfg = dotdigitalConfig(process.env, "SG");
  if (!cfg.user || !cfg.pass) {
    console.log("\n══ Dotdigital\n   not configured — set DOTDIGITAL_USER and DOTDIGITAL_PASS");
    return;
  }

  const info = await dotdigitalAccountInfo(cfg);
  const base = `https://${info.region}-api.dotdigital.com`;
  console.log(`\n══ Dotdigital · account ${info.id || "?"} · region ${info.region}${info.discovered ? " (discovered)" : ""}`);

  const budget = deadline(600000);
  const campaigns = await listSentCampaigns(base, cfg, START, budget);
  console.log(`   ${campaigns.length} sent campaigns with activity since ${START}\n`);
  if (!campaigns.length) return;

  // ── from-addresses: free, already on every campaign ──────────────────────────────
  const byFrom = new Map();
  for (const c of campaigns) {
    const k = c.from || "(none)";
    if (!byFrom.has(k)) byFrom.set(k, []);
    byFrom.get(k).push(c);
  }
  console.log("   ── from-addresses (free to filter on: the address is already in the campaign list)");
  console.log(`   ${pad("FROM ADDRESS", 42)}${pad("SENDS", 8)}SAMPLE CAMPAIGNS`);
  const froms = [...byFrom.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [addr, cs] of froms) {
    const sample = cs.slice(0, 2).map((c) => c.name).filter(Boolean).join(" / ").slice(0, 60);
    console.log(`   ${pad(addr, 42)}${pad(num(cs.length), 8)}${sample}`);
  }

  // ── address books in the account ─────────────────────────────────────────────────
  const books = await requestJSON(`${base}/v2/address-books`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.pass}`).toString("base64")}`,
      Accept: "application/json",
    },
    query: { select: 1000 },
    label: "Dotdigital address books",
  }).catch(() => []);
  const bookName = new Map((Array.isArray(books) ? books : []).map((b) => [String(b.id), b.name]));

  console.log(`\n   ── address books in the account (${bookName.size})`);
  console.log(`   ${pad("ID", 12)}${pad("CONTACTS", 12)}NAME`);
  for (const b of (Array.isArray(books) ? books : []).sort((a, b2) => (b2.contacts || 0) - (a.contacts || 0))) {
    console.log(`   ${pad(b.id, 12)}${pad(num(b.contacts || 0), 12)}${b.name}`);
  }

  // ── which books each campaign went to — only on request, it is one call each ─────
  if (WITH_BOOKS) {
    console.log(`\n   ── resolving address books for ${campaigns.length} campaigns…`);
    const got = await settledPool(
      campaigns.map((c) => () => campaignAddressBooks(base, cfg, c.id, budget)),
      5,
    );
    const byBook = new Map();
    got.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      for (const id of r.value) {
        if (!byBook.has(id)) byBook.set(id, []);
        byBook.get(id).push(campaigns[i]);
      }
    });
    console.log(`   ${pad("BOOK ID", 12)}${pad("SENDS", 8)}${pad("NAME", 38)}SAMPLE CAMPAIGN`);
    for (const [id, cs] of [...byBook.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(
        `   ${pad(id, 12)}${pad(num(cs.length), 8)}${pad((bookName.get(id) || "?").slice(0, 36), 38)}` +
          `${(cs[0].name || "").slice(0, 40)}`,
      );
    }
  } else {
    console.log("\n   (re-run with --books to see which address books each campaign was sent to)");
  }

  console.log("\n   ── paste into .env, one line per store, ids only");
  console.log("   # split on sender — cheapest, and immune to a campaign being renamed:");
  DD_STORES.forEach((s) => console.log(`   DOTDIGITAL_FROM_${s}=`));
  console.log("   # …or on address book, where two stores share a sender:");
  DD_STORES.forEach((s) => console.log(`   # DOTDIGITAL_ADDRESS_BOOKS_${s}=`));
}

/* ── Klaviyo ───────────────────────────────────────────────────────────────────── */

async function klaviyo() {
  const cfg = klaviyoConfig(process.env, "MONOSG");
  if (!cfg.key) {
    console.log("\n══ Klaviyo\n   not configured — set KLAVIYO_API_KEY");
    return;
  }
  console.log("\n══ Klaviyo");

  const h = {
    Authorization: `Klaviyo-API-Key ${cfg.key}`,
    revision: cfg.revision,
    accept: "application/vnd.api+json",
  };
  const pageAll = async (url, label) => {
    const out = [];
    let next = url;
    for (let i = 0; next && i < 40; i++) {
      const j = await requestJSON(next, { headers: h, label, retries: 1 });
      out.push(...(Array.isArray(j?.data) ? j.data : []));
      next = j?.links?.next || null;
    }
    return out;
  };

  const [campaigns, lists, segments] = await Promise.all([
    pageAll(
      `${BASE_K}/api/campaigns?filter=${encodeURIComponent("equals(messages.channel,'email')")}` +
        `&fields[campaign]=name,send_time,audiences&page[size]=100`,
      "Klaviyo campaigns",
    ),
    // /api/lists and /api/segments cap page[size] at 10 — campaigns allows 100. Sending
    // 100 here 400s, and the catch below turns that into every audience name reading "?".
    pageAll(`${BASE_K}/api/lists?fields[list]=name&page[size]=10`, "Klaviyo lists").catch(
      (e) => (console.log(`   (list names unavailable: ${e.message})`), []),
    ),
    pageAll(`${BASE_K}/api/segments?fields[segment]=name&page[size]=10`, "Klaviyo segments").catch(
      (e) => (console.log(`   (segment names unavailable: ${e.message})`), []),
    ),
  ]);

  const name = new Map();
  lists.forEach((l) => name.set(String(l.id), `list: ${l?.attributes?.name || "?"}`));
  segments.forEach((s) => name.set(String(s.id), `segment: ${s?.attributes?.name || "?"}`));

  const byAudience = new Map();
  let sent = 0;
  for (const c of campaigns) {
    const when = String(c?.attributes?.send_time || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(when) || when < START || when > END) continue;
    sent++;
    for (const a of c?.attributes?.audiences?.included || []) {
      const k = String(a);
      if (!byAudience.has(k)) byAudience.set(k, []);
      byAudience.get(k).push(c);
    }
  }
  console.log(`   ${sent} sends between ${START} and ${END}\n`);
  console.log(`   ${pad("AUDIENCE ID", 14)}${pad("SENDS", 8)}${pad("NAME", 40)}SAMPLE CAMPAIGN`);
  for (const [id, cs] of [...byAudience.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(
      `   ${pad(id, 14)}${pad(num(cs.length), 8)}${pad((name.get(id) || "?").slice(0, 38), 40)}` +
        `${(cs[0]?.attributes?.name || "").slice(0, 40)}`,
    );
  }

  console.log("\n   ── paste into .env");
  KL_STORES.forEach((s) => console.log(`   KLAVIYO_LIST_${s}=`));
}

const BASE_K = "https://a.klaviyo.com";

try {
  await dotdigital();
} catch (e) {
  console.log(`\n══ Dotdigital\n   ${e.reason || "error"}: ${e.message}`);
}
try {
  await klaviyo();
} catch (e) {
  console.log(`\n══ Klaviyo\n   ${e.reason || "error"}: ${e.message}`);
}
console.log(
  "\nPick the id that separates the brands cleanly and set one variable per store. " +
    "Then run `npm run preview-email` — it checks no two stores ended up on the same one.\n",
);
