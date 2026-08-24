// lib/ads-meta.js
// Meta (Facebook/Instagram) Marketing API — daily campaign insights.
//
// Auth: a Business-Manager SYSTEM USER token with `ads_read` on the ad accounts. System
// user tokens are long-lived and need no App Review for your own accounts, so there is
// no refresh plumbing here — one env var per market/store and it keeps working.
//
//   META_ACCESS_TOKEN[_<STORE>|_<MARKET>]   system-user token (ads_read)
//   META_AD_ACCOUNT_<STORE>                 act_123… (comma-separate several accounts)
//                                           META_AD_ACCOUNT_SG / _MY also accepted for
//                                           the two iORA stores
//   META_API_VERSION                        default below; set it if Meta sunsets that
//                                           version before this file is next touched
//   META_BUSINESS_ID                        Business Manager, for account DISCOVERY only
//                                           (see discoverAdAccounts at the foot of this
//                                           file) — never for the live pull, which reads
//                                           the explicit META_AD_ACCOUNT_<STORE> mapping
//
// Endpoint: an ASYNC insights job — POST /{version}/act_<id>/insights (level=campaign,
// time_increment=1) returns a report_run_id; poll GET /{version}/{run_id} until
// async_status is "Job Completed", then page GET /{version}/{run_id}/insights. One row
// per campaign per day — exactly the grain lib/ads.js rolls up.
//
// The plain synchronous GET cannot serve this: Meta cuts it off at ~30s server-side, so
// anything past about a month fails regardless of access tier (see submitJob).

import { ApiError, requestJSON } from "./http.js";
import { LIVE_BRANDS, envCred, envId, marketOf } from "./env-keys.js";

const DEFAULT_VERSION = "v23.0";
// The async results endpoint serves 1000 rows a page; limit=2000 is refused outright
// ("Please reduce the amount of data you're asking for"). Measured 21 Aug 2026.
const PAGE_LIMIT = 1000;
const MAX_PAGES = 60; // 60k daily rows — far beyond any real account-year

const INSIGHT_FIELDS =
  "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values,account_currency";

// Job submission and each results page are quick; the wait is Meta's own compute, which
// `deadline` governs rather than any single request timeout.
const SUBMIT_TIMEOUT_MS = 20000;
const POLL_TIMEOUT_MS = 15000;
const PAGE_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 2000;
const POLL_INTERVAL_MAX_MS = 5000;
// Backstop for a caller with no deadline (a script): ~9 minutes of polling, well past
// any observed job (21–33s for a year of dailies) but not unbounded.
const MAX_POLLS = 120;
// A completed job must still leave room to page its results before the budget runs out.
const PAGING_RESERVE_MS = 8000;
// The account name/timezone read is a cheap single field pull, and only ever produces a
// label — it gets a short leash and no real retry budget.
const ACCOUNT_TIMEOUT_MS = 10000;

// The timezone the store trades in, to compare an ad account's day-bucketing against.
const MARKET_TZ = { SG: "Asia/Singapore", MY: "Asia/Kuala_Lumpur" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Meta reports conversions as a list of {action_type, value}. Several action types can
// describe the same purchase (pixel, omni, app), so summing them would double-count:
// take the FIRST type present, in this priority order, and use the same type for the
// value. `omni_purchase` first because it is Meta's own de-duplicated total.
const PURCHASE_ACTIONS = [
  "omni_purchase",
  "purchase",
  "offsite_conversion.fb_pixel_purchase",
  "web_in_store_purchase",
];

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/** act_123 | 123 -> act_123 */
function normalizeAccount(id) {
  const s = String(id).trim();
  if (!s) return "";
  return /^act_/.test(s) ? s : `act_${s.replace(/^act_?/, "")}`;
}

export function metaConfig(env, brand) {
  const token = envCred(env, "META_ACCESS_TOKEN", brand);
  const accounts = envId(env, "META_AD_ACCOUNT", brand);
  const ids = accounts.value
    .split(",")
    .map(normalizeAccount)
    .filter(Boolean);
  const version = (env.META_API_VERSION || DEFAULT_VERSION).trim();
  return { token: token.value, tokenName: token.name, ids, accountName: accounts.name, version };
}

function pickAction(list) {
  if (!Array.isArray(list)) return null;
  for (const type of PURCHASE_ACTIONS) {
    const hit = list.find((a) => a?.action_type === type);
    if (hit) return num(hit.value);
  }
  return null;
}

// Meta puts its real diagnosis in body.error.{code,message}. Map the ones that mean
// something different from their HTTP status.
function metaAccept(json) {
  const e = json?.error;
  if (!e) return;
  const code = Number(e.code);
  const msg = String(e.message || e.error_user_msg || "Meta API error");
  // 190/102 = the token itself is bad; 200/272/294 = the token is fine but lacks
  // permission on this account (a scope/asset-assignment problem, not a credential one).
  if (code === 190 || code === 102) throw new ApiError("auth", msg);
  if (code === 17 || code === 4 || code === 80000 || code === 80004) {
    throw new ApiError("throttle", msg);
  }
  if (code === 200 || code === 272 || code === 294) throw new ApiError("scope", msg);
  // 1 (unknown) and 2 (service temporarily unavailable) are how Meta reports a query it
  // gave up computing — the SYNCHRONOUS insights endpoint hard-cuts at ~30s, so any
  // range past about a month died here regardless of the access tier. That is why this
  // file submits an async job instead; seeing these now means something genuinely
  // transient on Meta's side, so say so rather than blaming the range.
  if (code === 1 || code === 2) {
    throw new ApiError("api", `${msg} (Meta-side service error, subcode ${e.error_subcode ?? "—"})`);
  }
  throw new ApiError("api", msg);
}

/** graph.facebook.com/<version>/<path>, or the Graph default version when falsy. */
const graphUrl = (version, path) =>
  version ? `https://graph.facebook.com/${version}/${path}` : `https://graph.facebook.com/${path}`;

/**
 * The account's display name and the timezone Meta buckets its daily rows in.
 *
 * Purely for labelling — act_317407367 (iORA SG) buckets days in America/Los_Angeles,
 * ~15h off the Singapore-time store revenue shown beside it, so monthly totals are
 * comparable while day-level ones are not. That has to be visible on the panel. A
 * failure here must never cost the section its data, so it resolves to null instead.
 */
async function fetchAccountLabel(cfg, accountId) {
  try {
    const json = await requestJSON(graphUrl(cfg.version, accountId), {
      headers: { Authorization: `Bearer ${cfg.token}` },
      query: { fields: "name,timezone_name" },
      label: `Meta account (${accountId})`,
      accept: metaAccept,
      timeoutMs: ACCOUNT_TIMEOUT_MS,
      retries: 1,
    });
    return {
      name: json?.name ? String(json.name) : null,
      timezone: json?.timezone_name ? String(json.timezone_name) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Ask Meta to compute an insights report in the background; returns its run id.
 *
 * Why async rather than a plain GET: the SYNCHRONOUS insights endpoint has a hard ~30s
 * server-side cutoff. Measured 21 Aug 2026 against act_317407367 on standard_access —
 * January alone returned in 26.2s, while Jan–Feb, Jan–Mar, Jan–Jun and the full
 * year-to-date ALL failed at ~30.2s (code 2/1504044, or 1/99). It is not a throttle and
 * not the access tier, so no client-side timeout and no amount of month-chunking makes a
 * year-long daily pull reliable — even the one-month query that passed failed on repeat.
 * An async job computes the same query server-side with no such ceiling.
 */
async function submitJob(cfg, accountId, { start, end, deadline }) {
  const notes = [];
  let version = cfg.version;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (deadline) deadline.check(`Meta ${accountId}`);
    try {
      const json = await requestJSON(graphUrl(version, `${accountId}/insights`), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          level: "campaign",
          fields: INSIGHT_FIELDS,
          time_increment: "1",
          time_range: JSON.stringify({ since: start, until: end }),
        }).toString(),
        label: `Meta insights job (${accountId})`,
        accept: metaAccept,
        timeoutMs: SUBMIT_TIMEOUT_MS,
      });
      const runId = json?.report_run_id;
      if (!runId) {
        throw new ApiError("api", `Meta insights job (${accountId}): no report_run_id returned`);
      }
      return { runId: String(runId), version, notes };
    } catch (e) {
      // A sunset API version is the one failure a caller can actually fix here: retry
      // once on the Graph default version and say so, instead of blanking the tab.
      if (
        version &&
        e instanceof ApiError &&
        /version|deprecat|unsupported (get|post) request|does not exist/i.test(e.message)
      ) {
        notes.push(
          `Meta API ${cfg.version} was rejected; retried on the Graph default version. ` +
            `Set META_API_VERSION to a current version.`,
        );
        version = null;
        continue;
      }
      throw e;
    }
  }
  throw new ApiError("api", `Meta insights job (${accountId}): could not be submitted`);
}

/** Poll a submitted job until Meta has finished computing it. */
async function awaitJob(cfg, { runId, version }, accountId, { deadline }) {
  let interval = POLL_INTERVAL_MS;
  let last = "pending";

  for (let poll = 0; poll < MAX_POLLS; poll++) {
    // Finishing the job is pointless with no budget left to read the results.
    if (deadline && deadline.remaining() <= PAGING_RESERVE_MS) {
      throw new ApiError(
        "timeout",
        `Meta insights (${accountId}): job ${runId} was still "${last}" when the budget ran ` +
          `out — Meta had not finished computing this range.`,
      );
    }
    await sleep(interval);
    interval = Math.min(Math.round(interval * 1.25), POLL_INTERVAL_MAX_MS);

    const json = await requestJSON(graphUrl(version, runId), {
      headers: { Authorization: `Bearer ${cfg.token}` },
      query: { fields: "async_status,async_percent_completion" },
      label: `Meta insights job status (${accountId})`,
      accept: metaAccept,
      timeoutMs: POLL_TIMEOUT_MS,
    });

    const status = String(json?.async_status || "");
    if (status) last = status;
    if (status === "Job Completed") return;
    // Meta reports a report it could not produce as Failed or Skipped. That is a dead
    // end, not something a retry fixes — fail the section rather than serve nothing
    // dressed up as zero.
    if (/Fail|Skipped/i.test(status)) {
      throw new ApiError(
        "api",
        `Meta insights (${accountId}): job ${runId} ended as "${status}" — Meta could not ` +
          `compute the report for this range.`,
      );
    }
  }
  throw new ApiError(
    "timeout",
    `Meta insights (${accountId}): job ${runId} was still "${last}" after ${MAX_POLLS} polls.`,
  );
}

/** Read every page of a completed job's results into the provider row shape. */
async function fetchJobRows(cfg, { runId, version }, accountId, { deadline }) {
  const rows = [];
  let currency = null;
  let url = graphUrl(version, `${runId}/insights`);
  let query = { limit: PAGE_LIMIT };

  for (let page = 0; page < MAX_PAGES; page++) {
    if (deadline) deadline.check(`Meta ${accountId}`);
    const json = await requestJSON(url, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      query,
      label: `Meta insights results (${accountId})`,
      accept: metaAccept,
      timeoutMs: PAGE_TIMEOUT_MS,
    });

    for (const r of Array.isArray(json?.data) ? json.data : []) {
      if (!currency && r.account_currency) currency = String(r.account_currency);
      rows.push({
        date: String(r.date_start || "").slice(0, 10),
        campaignId: r.campaign_id != null ? String(r.campaign_id) : null,
        campaign: r.campaign_name || null,
        spend: num(r.spend),
        impressions: num(r.impressions),
        clicks: num(r.clicks),
        purchases: pickAction(r.actions),
        revenue: pickAction(r.action_values),
      });
    }

    const next = json?.paging?.next;
    if (!next) return { rows, currency };
    url = next; // an absolute, fully-parameterised URL
    query = undefined;
  }
  throw new ApiError(
    "api",
    `Meta insights (${accountId}): more than ${MAX_PAGES} pages of daily rows — refusing to ` +
      `serve a truncated series.`,
  );
}

/**
 * Daily campaign rows for one brand, in lib/ads.js's provider contract.
 * Throws ApiError("not-configured") when this store has no Meta credentials — the
 * endpoint turns that into an honest blank, exactly like an unwired Shopify store.
 */
export async function fetchMetaAds(env, brand, { start, end, deadline } = {}) {
  const cfg = metaConfig(env, brand);
  if (!cfg.token || !cfg.ids.length) {
    throw new ApiError(
      "not-configured",
      `Meta ads are not configured for brand "${brand}". Set ${cfg.accountName} ` +
        `(act_…) and ${cfg.tokenName} (a system-user token with ads_read).`,
    );
  }

  const rows = [];
  const notes = [];
  const currencies = new Set();

  // Submit every account's job BEFORE waiting on any of them, so Meta computes them
  // concurrently. Measured 21 Aug 2026: SG and MY submitted together both completed in
  // 24.7s, against 33.4s + 21.7s = 55.1s waiting for one then the other. The submits
  // themselves also go out together — they are independent POSTs, and serialising them
  // delayed the later accounts' compute by a round trip each.
  // Started here, read at the end: these cheap label reads run while Meta is computing
  // the jobs, so they cost the pull nothing.
  const labels = Promise.all(cfg.ids.map((id) => fetchAccountLabel(cfg, id)));

  const jobs = await Promise.all(
    cfg.ids.map(async (id) => ({ id, job: await submitJob(cfg, id, { start, end, deadline }) })),
  );
  for (const { job } of jobs) notes.push(...job.notes);

  const collected = await Promise.all(
    jobs.map(async ({ id, job }) => {
      await awaitJob(cfg, job, id, { deadline });
      return fetchJobRows(cfg, job, id, { deadline });
    }),
  );

  for (const r of collected) {
    rows.push(...r.rows);
    if (r.currency) currencies.add(r.currency);
  }
  if (currencies.size > 1) {
    // Adding MYR spend to SGD spend would be a fabricated number. Refuse.
    throw new ApiError(
      "api",
      `Meta accounts for "${brand}" report different currencies (${[...currencies].join(", ")}). ` +
        `Split them across separate brands rather than mixing currencies in one total.`,
    );
  }

  // Purchases + their value come from the same `actions`/`action_values` payload; a
  // pixel that isn't reporting yields nulls per row, which roll up as 0 — so we only
  // claim support when at least one row actually carried a purchase action.
  const supports = {
    purchases: rows.some((r) => r.purchases != null),
    revenue: rows.some((r) => r.revenue != null),
    budget: false,
  };

  // Meta counts conversions IT attributes to an ad inside its own click/view window;
  // Shopify counts orders. The two will never tie, which is correct but is the first
  // thing anyone asks when they see them side by side — so the panel says it outright,
  // rather than letting a ROAS figure imply a reconciliation to store revenue.
  if (supports.purchases || supports.revenue) {
    notes.push(
      "Purchases, revenue and ROAS here are Meta-attributed — conversions Meta credits " +
        "to an ad within its own click/view window, not Shopify orders. They are not " +
        "expected to tie to store revenue.",
    );
  }

  const storeTz = MARKET_TZ[marketOf(brand)];
  (await labels).forEach((label, i) => {
    if (!label?.timezone || !storeTz || label.timezone === storeTz) return;
    notes.push(
      `Meta account ${label.name || cfg.ids[i]} buckets its days in ${label.timezone}, not ` +
        `${storeTz}. Monthly totals are comparable with store revenue; day-level and ` +
        `edge-of-month figures are not.`,
    );
  });

  return {
    currency: [...currencies][0] || null,
    supports,
    rows,
    notes,
    accounts: cfg.ids,
  };
}

// ---------------------------------------------------------------------------
// Account discovery — ops tooling for scripts/meta-accounts.js.
//
// A SYSTEM USER token has no useful /me/adaccounts edge: `me` resolves to the system
// user itself, which owns no assets, so that call comes back empty and reads like a
// broken token. The accounts hang off the BUSINESS, on two separate edges —
// owned_ad_accounts (owned outright by the business, which is where act_317407367
// iORA SG lives) and client_ad_accounts (shared in from another business). Read both
// and dedupe by id, because an account can legitimately appear on either.
//
// Discovery deliberately does NOT feed fetchMetaAds. Which act_ id belongs to which
// brand stays an explicit META_AD_ACCOUNT_<STORE> mapping, for the same reason the POS
// SKU prefixes are a fixed table: accounts get renamed in Ads Manager ("SANS Ad" vs
// "SANS & SANS - Ad Account"), and a rename must never silently re-attribute spend.
// Discovery is how you FIND the ids to put in that mapping, and how you notice an
// account that is live in Business Manager but mapped to no brand at all.
// ---------------------------------------------------------------------------

/** IORA Group's Business Manager. Override with META_BUSINESS_ID. */
export const DEFAULT_BUSINESS_ID = "158508188091469";

const DISCOVERY_EDGES = ["owned_ad_accounts", "client_ad_accounts"];
const DISCOVERY_FIELDS = "id,account_id,name,account_status,currency,timezone_name,amount_spent";
const DISCOVERY_PAGE_LIMIT = 100;
// Ten accounts under a limit of 100 will not page today, but accounts get added —
// follow paging.next rather than silently truncating a year from now.
const DISCOVERY_MAX_PAGES = 20;
const DISCOVERY_TIMEOUT_MS = 20000;

// Accounts that live in the Business Manager but are not brand spend. Excluded BY ID,
// never by name, so renaming one cannot quietly readmit it to the rollups.
// act_2311636498906929 "Hao Ping Ng" — a personal ad account.
const EXCLUDED_ACCOUNT_IDS = ["act_2311636498906929"];

// Meta's account_status codes. Only 1 is spendable; the rest are worth SEEING in the
// ops report rather than silently dropping, because a brand account that has flipped to
// 2 or 3 is exactly what makes a dashboard panel go quiet for no visible reason.
const ACCOUNT_STATUS = {
  1: "ACTIVE",
  2: "DISABLED",
  3: "UNSETTLED",
  7: "PENDING_RISK_REVIEW",
  8: "PENDING_SETTLEMENT",
  9: "IN_GRACE_PERIOD",
  100: "PENDING_CLOSURE",
  101: "CLOSED",
  201: "ANY_ACTIVE",
  202: "ANY_CLOSED",
};

/** Ids kept out of brand rollups: the built-ins plus META_AD_ACCOUNT_EXCLUDE. */
export function excludedAccountIds(env = {}) {
  const extra = String(env.META_AD_ACCOUNT_EXCLUDE || "")
    .split(",")
    .map(normalizeAccount)
    .filter(Boolean);
  return new Set([...EXCLUDED_ACCOUNT_IDS, ...extra]);
}

/** Read one business edge, following paging.next. */
async function fetchBusinessEdge(cfg, businessId, edge) {
  const out = [];
  let url = graphUrl(cfg.version, `${businessId}/${edge}`);
  let query = { fields: DISCOVERY_FIELDS, limit: DISCOVERY_PAGE_LIMIT };

  for (let page = 0; page < DISCOVERY_MAX_PAGES; page++) {
    const json = await requestJSON(url, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      query,
      label: `Meta ${edge} (${businessId})`,
      accept: metaAccept,
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    });
    for (const a of Array.isArray(json?.data) ? json.data : []) out.push(a);

    const next = json?.paging?.next;
    if (!next) return out;
    url = next; // absolute and fully parameterised
    query = undefined;
  }
  throw new ApiError(
    "api",
    `Meta ${edge} (${businessId}): more than ${DISCOVERY_MAX_PAGES} pages — refusing to serve ` +
      `a truncated account list.`,
  );
}

/**
 * Every ad account the token can see under the business, from both edges, deduped.
 *
 * Returns { businessId, version, accounts, notes }. Each account carries
 * { id, name, status, statusLabel, active, excluded, currency, timezone, amountSpent,
 *   edges } — NOTHING is filtered out, so a disabled or excluded account shows up as
 * such instead of silently vanishing from the report.
 */
export async function discoverAdAccounts(env, { brand = "SG", businessId } = {}) {
  const cfg = metaConfig(env, brand);
  if (!cfg.token) {
    throw new ApiError(
      "not-configured",
      `No Meta token: set ${cfg.tokenName} to a system-user token with ads_read.`,
    );
  }
  const biz = String(businessId || env.META_BUSINESS_ID || DEFAULT_BUSINESS_ID).trim();
  const skip = excludedAccountIds(env);
  const notes = [];

  const failures = [];
  const perEdge = await Promise.all(
    DISCOVERY_EDGES.map(async (edge) => {
      try {
        return { edge, rows: await fetchBusinessEdge(cfg, biz, edge) };
      } catch (e) {
        // One edge failing (a permission covering owned but not client assets, say)
        // must not blank the other — report it and carry on with what we have.
        failures.push(e);
        notes.push(`${edge} could not be read: ${e.message}`);
        return { edge, rows: [] };
      }
    }),
  );
  // Every edge down is one failure, not a discovery result — and it is nearly always a
  // dead token. Re-throw the FIRST error rather than a summary of both, so the caller
  // still sees reason:"auth" (regenerate the token) or "scope" (assign the system user
  // to the accounts) instead of a generic "api" it can do nothing with.
  if (failures.length === DISCOVERY_EDGES.length) throw failures[0];

  const byId = new Map();
  for (const { edge, rows } of perEdge) {
    for (const a of rows) {
      const id = normalizeAccount(a.id || a.account_id);
      if (!id) continue;
      const existing = byId.get(id);
      if (existing) {
        existing.edges.push(edge);
        continue;
      }
      const status = Number(a.account_status);
      byId.set(id, {
        id,
        name: a.name ? String(a.name) : null,
        status,
        statusLabel: ACCOUNT_STATUS[status] || `UNKNOWN(${a.account_status})`,
        active: status === 1,
        excluded: skip.has(id),
        currency: a.currency ? String(a.currency) : null,
        timezone: a.timezone_name ? String(a.timezone_name) : null,
        // Lifetime, in the account's minor unit (cents). Never a date-filtered figure —
        // fetchAccountSpend does that.
        amountSpent: a.amount_spent != null ? num(a.amount_spent) / 100 : null,
        edges: [edge],
      });
    }
  }

  const accounts = [...byId.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return { businessId: biz, version: cfg.version, accounts, notes };
}

/**
 * Account-level spend over one date range — the "does this legacy account still spend?"
 * check, before deciding whether it belongs in the dashboard at all.
 *
 * A single aggregate row is cheap enough for the SYNCHRONOUS endpoint; the async job in
 * fetchMetaAds exists because a YEAR OF DAILY CAMPAIGN rows is not.
 */
export async function fetchAccountSpend(env, accountId, { start, end, brand = "SG" } = {}) {
  const cfg = metaConfig(env, brand);
  const id = normalizeAccount(accountId);
  const json = await requestJSON(graphUrl(cfg.version, `${id}/insights`), {
    headers: { Authorization: `Bearer ${cfg.token}` },
    query: {
      level: "account",
      fields: "spend,impressions,account_currency",
      time_range: JSON.stringify({ since: start, until: end }),
    },
    label: `Meta account spend (${id})`,
    accept: metaAccept,
    timeoutMs: PAGE_TIMEOUT_MS,
  });
  const row = Array.isArray(json?.data) ? json.data[0] : null;
  // No row at all is Meta saying "nothing ran in this window" — a real zero, because the
  // query itself succeeded. A failed query throws above and never reaches here.
  return {
    spend: row ? num(row.spend) : 0,
    impressions: row ? num(row.impressions) : 0,
    currency: row?.account_currency ? String(row.account_currency) : null,
  };
}

/**
 * The act_id -> brand mapping the dashboard actually runs on, read back out of the
 * environment: { map: Map(actId -> [{brand, market, envName}]), brands: {...} }.
 * A LIST per id, not one entry, so meta-accounts.js can shout about an account wired to
 * two brands rather than quietly picking one.
 */
export function metaAccountMap(env) {
  const map = new Map();
  const brands = {};
  for (const brand of LIVE_BRANDS) {
    const cfg = metaConfig(env, brand);
    brands[brand] = { ids: cfg.ids, envName: cfg.accountName };
    for (const id of cfg.ids) {
      if (!map.has(id)) map.set(id, []);
      map.get(id).push({ brand, market: marketOf(brand), envName: cfg.accountName });
    }
  }
  return { map, brands };
}
