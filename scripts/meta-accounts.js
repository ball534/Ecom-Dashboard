// scripts/meta-accounts.js
// Lists every Meta ad account under the IORA Group Business Manager and reconciles it
// against the META_AD_ACCOUNT_<STORE> mapping the dashboard actually runs on.
//
//   npm run meta-accounts                          # accounts + lifetime spend
//   npm run meta-accounts 2026-01-01 2026-08-25    # + spend in that window
//   npm run meta-accounts --json                   # machine-readable
//
// Why this exists: a system-user token sees NOTHING on /me/adaccounts (`me` is the
// system user, which owns no assets). The accounts hang off the BUSINESS, on two edges
// — owned_ad_accounts and client_ad_accounts — and both have to be read. An account the
// business owns outright (iORA SG, act_317407367) appears only on the first.
//
// Discovery is deliberately NOT wired into the live pull. act_ id -> brand stays an
// explicit env mapping, so that a rename in Ads Manager cannot re-attribute spend and a
// new account cannot appear in a rollup nobody chose to put it in. This script is how
// you find the ids for that mapping, and how you notice an account that is live in
// Business Manager but mapped to no brand at all.
//
// Exit 0 = mapping is consistent. Exit 1 = something would misreport if deployed.

import { loadEnv } from "./_env.js";
import {
  discoverAdAccounts,
  fetchAccountSpend,
  metaAccountMap,
  metaConfig,
} from "../lib/ads-meta.js";

loadEnv();

const JSON_OUT = process.argv.includes("--json");
const argv = process.argv.slice(2).filter((a) => a !== "--json");
const START = argv[0] || null;
const END = argv[1] || new Date().toISOString().slice(0, 10);
const RANGE = START ? { start: START, end: END } : null;

// The timezone each market's stores trade in, to flag day-bucketing that will not line
// up with the store revenue shown beside it.
const MARKET_TZ = { SG: "Asia/Singapore", MY: "Asia/Kuala_Lumpur" };

const money = (n, cur) =>
  n == null
    ? "—"
    : `${cur || ""} ${Number(n).toLocaleString("en-SG", { maximumFractionDigits: 0 })}`.trim();
const pad = (s, w) => String(s ?? "").padEnd(w);
const padS = (s, w) => String(s ?? "").padStart(w);
const mask = (t) => (t ? `${t.slice(0, 6)}…${t.slice(-4)} (len ${t.length})` : "(empty)");

function reportDiscoveryFailure(e) {
  console.error(`❌ Discovery failed (reason: ${e.reason || "error"})`);
  console.error("   " + String(e.message || e).slice(0, 500));
  console.error("");
  if (e.reason === "auth") {
    console.error("→ The token is dead, expired or was revoked. Regenerate it in Business");
    console.error("  Settings > Users > System Users > Generate New Token (ads_read), then");
    console.error("  update META_ACCESS_TOKEN here and in Vercel.");
  } else if (e.reason === "scope") {
    console.error("→ The token authenticates but has no access to the business's ad accounts.");
    console.error("  Assign the system user to them in Business Settings > Ad Accounts, or set");
    console.error("  META_BUSINESS_ID if they live under a different business.");
  } else if (e.reason === "not-configured") {
    console.error("→ Set META_ACCESS_TOKEN in .env (see .env.example).");
  }
}

/** Cross-check what Meta reports against what the dashboard is wired to. */
function reconcile({ accounts, businessId }, mapped, brands) {
  const problems = []; // exit 1 — these would misreport
  const warnings = []; // worth a human decision, but not wrong
  const discovered = new Map(accounts.map((a) => [a.id, a]));

  for (const a of accounts) {
    const wired = mapped.get(a.id) || [];
    if (wired.length > 1) {
      problems.push(
        `${a.id} (${a.name}) is wired to ${wired.length} brands — ` +
          `${wired.map((w) => `${w.brand} via ${w.envName}`).join(", ")}. ` +
          `Its spend would be counted twice in the GROUP rollup.`,
      );
    }
    if (a.excluded && wired.length) {
      problems.push(
        `${a.id} (${a.name}) is on the exclusion list but still wired to ` +
          `${wired.map((w) => w.brand).join(", ")}. Remove it from ${wired[0].envName}.`,
      );
    }
    if (!wired.length && a.active && !a.excluded) {
      warnings.push(
        `${a.id} (${a.name}) is ACTIVE but mapped to no brand — its spend appears in no rollup.`,
      );
    }
    if (wired.length && !a.active) {
      warnings.push(
        `${a.id} (${a.name}) is wired to ${wired[0].brand} but its status is ${a.statusLabel} — ` +
          `that panel will go quiet without saying why.`,
      );
    }
    for (const w of wired) {
      const tz = MARKET_TZ[w.market];
      if (a.timezone && tz && a.timezone !== tz) {
        warnings.push(
          `${a.id} (${a.name}) buckets days in ${a.timezone}, not ${tz} — monthly totals are ` +
            `comparable with ${w.brand} store revenue, day-level ones are not.`,
        );
      }
    }
  }

  // An env var pointing at an account this token cannot see fails at runtime — the panel
  // errors rather than blanking, so catch it here.
  for (const [id, wired] of mapped) {
    if (discovered.has(id)) continue;
    problems.push(
      `${wired[0].envName} points at ${id}, which is not under business ${businessId} for this ` +
        `token. ${wired[0].brand}'s Meta panel will fail, not blank.`,
    );
  }

  // fetchMetaAds refuses to total SGD and MYR into one figure. Say so here rather than
  // letting the dashboard be the one to discover it.
  for (const [brand, b] of Object.entries(brands)) {
    const curs = new Set(b.ids.map((id) => discovered.get(id)?.currency).filter(Boolean));
    if (curs.size > 1) {
      problems.push(
        `Brand ${brand} mixes currencies (${[...curs].join(", ")}) across ${b.ids.join(", ")}. ` +
          `fetchMetaAds refuses to total those — split them across separate brands.`,
      );
    }
  }

  return { problems, warnings };
}

function printReport(discovery, { mapped, brands, windowed, problems, warnings, cfg }) {
  const { accounts, businessId, notes } = discovery;

  console.log("");
  console.log(`Meta ad accounts — business ${businessId}, API ${discovery.version}`);
  console.log(`token ${cfg.tokenName} = ${mask(cfg.token)}`);
  console.log(
    RANGE
      ? `spend window: ${RANGE.start} → ${RANGE.end}`
      : "spend: lifetime (pass a start date for a windowed figure)",
  );
  console.log("");

  const W = { id: 22, name: 34, status: 12, cur: 5, spend: 15, brand: 11 };
  const width = Object.values(W).reduce((a, b) => a + b, 0) + 8;
  console.log(
    pad("account", W.id) +
      pad("name", W.name) +
      pad("status", W.status) +
      pad("cur", W.cur) +
      padS(RANGE ? "spend (window)" : "spend (lifetime)", W.spend) +
      "  " +
      pad("brand", W.brand) +
      "edge",
  );
  console.log("-".repeat(width));

  for (const a of accounts) {
    const wired = mapped.get(a.id) || [];
    const w = windowed.get(a.id);
    const spend = RANGE
      ? w?.error
        ? `! ${w.error}`
        : money(w?.spend, a.currency)
      : money(a.amountSpent, a.currency);
    console.log(
      pad(a.id, W.id) +
        pad((a.name || "(unnamed)").slice(0, W.name - 1), W.name) +
        pad(a.active ? a.statusLabel : `! ${a.statusLabel}`, W.status) +
        pad(a.currency || "—", W.cur) +
        padS(spend, W.spend) +
        "  " +
        pad(a.excluded ? "EXCLUDED" : wired.map((x) => x.brand).join("+") || "—", W.brand) +
        a.edges.map((e) => e.replace("_ad_accounts", "")).join("+"),
    );
  }

  console.log("");
  console.log(
    `${accounts.length} accounts · ${accounts.filter((a) => a.active).length} active · ` +
      `${accounts.filter((a) => mapped.has(a.id)).length} wired to a brand · ` +
      `${accounts.filter((a) => a.excluded).length} excluded`,
  );
  for (const n of notes) console.log(`note: ${n}`);

  const unconfigured = Object.entries(brands).filter(([, b]) => !b.ids.length);
  if (unconfigured.length) {
    console.log("");
    console.log("Brands with no Meta account set (their panel stays an honest blank):");
    for (const [brand, b] of unconfigured) console.log(`  ${pad(brand, 8)} set ${b.envName}`);
  }

  const orphans = accounts.filter((a) => a.active && !a.excluded && !mapped.has(a.id));
  if (orphans.length) {
    console.log("");
    console.log("Active, spending, mapped to nothing — decide which brand owns each, then");
    console.log("add it to .env (or to META_AD_ACCOUNT_EXCLUDE if it is not brand spend):");
    for (const a of orphans) {
      const w = windowed.get(a.id);
      const spend = RANGE && !w?.error ? `  # ${money(w?.spend, a.currency)} in window` : "";
      console.log(`  # ${a.name}${spend}`);
      console.log(`  META_AD_ACCOUNT_<STORE>=${a.id}`);
    }
  }

  if (warnings.length) {
    console.log("");
    console.log("⚠️  Worth a look:");
    for (const w of warnings) console.log(`  - ${w}`);
  }

  if (problems.length) {
    console.log("");
    console.log("❌ Would misreport if deployed:");
    for (const p of problems) console.log(`  - ${p}`);
    return 1;
  }

  console.log("");
  console.log(
    warnings.length
      ? "✅ Nothing would misreport. The items above are decisions to make, not faults."
      : "✅ Every wired account exists, is active and belongs to exactly one brand.",
  );
  return 0;
}

async function main() {
  const env = process.env;
  const cfg = metaConfig(env, "SG");
  const { map: mapped, brands } = metaAccountMap(env);

  let discovery;
  try {
    discovery = await discoverAdAccounts(env);
  } catch (e) {
    reportDiscoveryFailure(e);
    return 1;
  }

  // Spend inside the requested window, per account — the "is this legacy account still
  // live?" check. One aggregate row each, so the synchronous endpoint is fine here; the
  // async job in fetchMetaAds exists for a year of daily campaign rows, not for this.
  const windowed = new Map();
  if (RANGE) {
    await Promise.all(
      discovery.accounts.map(async (a) => {
        try {
          windowed.set(a.id, await fetchAccountSpend(env, a.id, RANGE));
        } catch (e) {
          windowed.set(a.id, { error: e.reason || "error", message: String(e.message || e) });
        }
      }),
    );
  }

  const { problems, warnings } = reconcile(discovery, mapped, brands);

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          businessId: discovery.businessId,
          version: discovery.version,
          range: RANGE,
          accounts: discovery.accounts.map((a) => ({
            ...a,
            brands: (mapped.get(a.id) || []).map((w) => w.brand),
            windowSpend: windowed.get(a.id) || null,
          })),
          brandsWithNoAccount: Object.entries(brands)
            .filter(([, b]) => !b.ids.length)
            .map(([brand]) => brand),
          problems,
          warnings,
          notes: discovery.notes,
        },
        null,
        2,
      ),
    );
    return problems.length ? 1 : 0;
  }

  return printReport(discovery, { mapped, brands, windowed, problems, warnings, cfg });
}

// process.exitCode rather than process.exit(): exiting hard while Meta requests are
// still tearing down trips a libuv assertion on Windows.
process.exitCode = await main();
