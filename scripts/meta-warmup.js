// scripts/meta-warmup.js
// Generates the call volume Meta requires before it grants the "Marketing API
// Access Tier" feature (App Review). Meta's criteria, as at August 2026:
//   * at least 500 successful Marketing API calls in the last 15 days, and
//   * an error rate under 15% across the last 500 calls.
// The app is on Development Access until then, so this loops CHEAP read-only
// requests (account fields, campaign list, a 7-day account insight every 6th
// call) against every configured ad account, paced far inside the Development
// Access budget.
//
//   npm run meta-warmup              # top up to 800 in-window calls, 45s apart
//   npm run meta-warmup 200 30       # custom target / interval-seconds
//   npm run meta-warmup status       # report only — makes no API calls
//
// IMPORTANT — the 15-day window is TRAILING, and Meta's App Review counter lags
// up to 24h behind. The 13 Aug 2026 rejection happened because only 468 calls
// had aged into Meta's counter by review time; the 52 that crossed the 500 line
// arrived under 10h before the decision and were still invisible. So:
//   1. aim well past 500 (default target 800) — the threshold is a floor, not a goal;
//   2. finish the run in one sitting (a stalled machine mid-run caused a 25.5h gap);
//   3. wait a full 48h after the last call before submitting App Review.
//
// History is derived from meta-warmup.log, which timestamps every call — that is
// what makes the trailing-window count possible. .meta-warmup-state.json is kept
// as a convenience summary only; deleting it changes nothing. Meta keeps the
// authoritative tally server-side (App Dashboard > App Review > Permissions and
// Features shows the live count).
//
// On a throttle response (code 4/17/8000x) it waits 15 minutes and carries on —
// a throttled call still counts against the 85% success requirement, so slow and
// steady beats fast. A token error (190/102) aborts: re-running would only farm
// failures.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadEnv } from "./_env.js";
import { metaConfig } from "../lib/ads-meta.js";

loadEnv();

const STATUS_ONLY = process.argv[2] === "status";
const TARGET = Number(STATUS_ONLY ? 0 : process.argv[2] || 800);
const INTERVAL_MS = Number(process.argv[3] || 45) * 1000;
const BACKOFF_MS = 15 * 60 * 1000;
const WINDOW_MS = 15 * 24 * 60 * 60 * 1000;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, ".meta-warmup-state.json");
const LOG_PATH = resolve(ROOT, "meta-warmup.log");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  appendFileSync(LOG_PATH, stamped + "\n");
};

// Every call this script has ever made, oldest first, recovered from the log.
// Lines look like "<iso> #12 ok (12/800) SG act_… account fields" or
// "<iso> #12 error code 4 (http 400) act_… …". Network errors never reached
// Meta, so they are deliberately not matched.
const readHistory = () => {
  let text;
  try {
    text = readFileSync(LOG_PATH, "utf8");
  } catch {
    return [];
  }
  const history = [];
  for (const line of text.split("\n")) {
    const m = /^(\S+) #\d+ (ok|error code)/.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (Number.isFinite(at)) history.push({ at, ok: m[2] === "ok" });
  }
  return history;
};

// What Meta's reviewer sees: successes inside the trailing window, plus the
// error rate over the most recent 500 calls of any outcome.
const tally = (history) => {
  const cutoff = Date.now() - WINDOW_MS;
  const inWindow = history.filter((c) => c.at >= cutoff);
  const recent = history.slice(-500);
  const recentErrors = recent.filter((c) => !c.ok).length;
  return {
    ok: inWindow.filter((c) => c.ok).length,
    failed: inWindow.filter((c) => !c.ok).length,
    errorRate: recent.length ? (recentErrors / recent.length) * 100 : 0,
    // When the oldest in-window success ages out, dropping the count by one.
    expiresAt: inWindow.length ? new Date(inWindow[0].at + WINDOW_MS) : null,
  };
};

const report = (t) => {
  const parts = [
    `${t.ok} successful call(s) inside the trailing 15 days (Meta needs ≥500)`,
    `error rate ${t.errorRate.toFixed(1)}% over the last 500 calls (Meta needs <15%)`,
  ];
  if (t.expiresAt) parts.push(`oldest starts ageing out ${t.expiresAt.toISOString().slice(0, 10)}`);
  return parts.join("; ");
};

const history = readHistory();

if (STATUS_ONLY) {
  const t = tally(history);
  console.log(report(t));
  console.log(
    t.ok >= 500
      ? "Threshold met. Meta's counter lags up to 24h — wait 48h after the last call, " +
        "confirm the count in App Dashboard > App Review > Permissions and Features, then submit."
      : `Short by ${500 - t.ok}. Run: npm run meta-warmup`
  );
  process.exit(0);
}

// Collect every configured account across brands; each carries its own token in
// case the two markets ever get separate system users.
const accounts = [];
for (const brand of ["SG", "MY"]) {
  const cfg = metaConfig(process.env, brand);
  if (!cfg.token || !cfg.ids.length) continue;
  for (const id of cfg.ids) accounts.push({ brand, id, token: cfg.token, version: cfg.version });
}
if (!accounts.length) {
  console.error("No Meta credentials found in .env (META_ACCESS_TOKEN / META_AD_ACCOUNT_*).");
  process.exit(1);
}

// Three request shapes, cheapest first. Insights has its own, much smaller
// Development Access budget (it is what rate-limited the dashboard), so it only
// takes every 6th slot.
const requestFor = (acct, n) => {
  const base = `https://graph.facebook.com/${acct.version}/${acct.id}`;
  if (n % 6 === 5) {
    return {
      kind: "insights last_7d",
      url: `${base}/insights?date_preset=last_7d&level=account&fields=spend,impressions,clicks`,
    };
  }
  if (n % 2 === 0) {
    return { kind: "account fields", url: `${base}?fields=name,currency,account_status,timezone_name` };
  }
  return { kind: "campaign list", url: `${base}/campaigns?fields=name,status,objective&limit=25` };
};

let n = history.length;
let t = tally(history);

if (t.ok >= TARGET) {
  log(`nothing to do — already at ${report(t)}`);
  process.exit(0);
}

const eta = new Date(Date.now() + (TARGET - t.ok) * INTERVAL_MS);
log(
  `warmup start — ${accounts.length} account(s), target ${TARGET} in-window successes, ` +
  `${INTERVAL_MS / 1000}s interval. Currently ${report(t)}. ` +
  `Est. finish ${eta.toISOString()} — keep this machine awake; a mid-run stall is what sank the last attempt.`
);

while (t.ok < TARGET) {
  const acct = accounts[n % accounts.length];
  const req = requestFor(acct, n);
  n++;

  let json, httpStatus;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const resp = await fetch(req.url, {
      headers: { Authorization: `Bearer ${acct.token}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    httpStatus = resp.status;
    json = await resp.json();
  } catch (e) {
    // Network failure never reached Meta, so it cannot hurt the success rate.
    log(`#${n} network-error ${acct.id} ${req.kind}: ${e.message} — retrying next tick`);
    await sleep(INTERVAL_MS);
    continue;
  }

  const err = json?.error;
  let throttled = false;
  if (!err) {
    history.push({ at: Date.now(), ok: true });
  } else {
    const code = Number(err.code);
    if (code === 190 || code === 102) {
      log(`#${n} FATAL token error ${code}: ${err.message}`);
      process.exit(1);
    }
    history.push({ at: Date.now(), ok: false });
    throttled = code === 4 || code === 17 || code === 80000 || code === 80004;
  }

  t = tally(history);
  writeFileSync(
    STATE_PATH,
    JSON.stringify({ inWindowOk: t.ok, inWindowFailed: t.failed, errorRatePct: Number(t.errorRate.toFixed(1)), updatedAt: new Date().toISOString() }, null, 2) + "\n"
  );

  if (!err) {
    log(`#${n} ok (${t.ok}/${TARGET} in-window) ${acct.brand} ${acct.id} ${req.kind}`);
  } else {
    log(`#${n} error code ${err.code} (http ${httpStatus}) ${acct.id} ${req.kind}: ${err.message}`);
    if (throttled) {
      log(`   throttled — backing off ${BACKOFF_MS / 60000} min`);
      await sleep(BACKOFF_MS);
      continue;
    }
  }

  if (t.ok < TARGET) await sleep(INTERVAL_MS);
}

log(`warmup done — ${report(t)}. Wait 48h for Meta's counter to catch up before submitting App Review.`);
