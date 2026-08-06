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
//
// Endpoint: GET /{version}/act_<id>/insights?level=campaign&time_increment=1
// Returns one row per campaign per day — exactly the grain lib/ads.js rolls up.

import { ApiError, requestJSON } from "./http.js";
import { envCred, envId } from "./env-keys.js";

const DEFAULT_VERSION = "v23.0";
const PAGE_LIMIT = 500;
const MAX_PAGES = 60; // 30k daily rows — far beyond any real account-year

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
  throw new ApiError("api", msg);
}

async function fetchAccount(cfg, accountId, { start, end, deadline }) {
  const rows = [];
  const notes = [];
  let currency = null;
  let url =
    `https://graph.facebook.com/${cfg.version}/${accountId}/insights`;
  let query = {
    level: "campaign",
    fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values,account_currency",
    time_increment: 1,
    time_range: JSON.stringify({ since: start, until: end }),
    limit: PAGE_LIMIT,
  };

  for (let page = 0; page < MAX_PAGES; page++) {
    if (deadline) deadline.check(`Meta ${accountId}`);
    let json;
    try {
      json = await requestJSON(url, {
        headers: { Authorization: `Bearer ${cfg.token}` },
        query,
        label: `Meta insights (${accountId})`,
        accept: metaAccept,
        timeoutMs: 25000,
      });
    } catch (e) {
      // A sunset API version is the one failure a caller can actually fix here: retry
      // once on the Graph default version and say so, instead of blanking the tab.
      const versioned = /\/v\d+\.\d+\//.test(url);
      if (
        versioned &&
        e instanceof ApiError &&
        /version|deprecat|unsupported get request|does not exist/i.test(e.message)
      ) {
        notes.push(
          `Meta API ${cfg.version} was rejected; retried on the Graph default version. ` +
            `Set META_API_VERSION to a current version.`,
        );
        url = url.replace(/\/v\d+\.\d+\//, "/");
        page--;
        continue;
      }
      throw e;
    }

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
    if (!next) break;
    url = next; // an absolute, fully-parameterised URL
    query = undefined;
    if (page === MAX_PAGES - 1) {
      throw new ApiError(
        "api",
        `Meta insights (${accountId}): more than ${MAX_PAGES} pages of daily rows — refusing to ` +
          `serve a truncated series.`,
      );
    }
  }
  return { rows, currency, notes };
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
  for (const id of cfg.ids) {
    const r = await fetchAccount(cfg, id, { start, end, deadline });
    rows.push(...r.rows);
    notes.push(...r.notes);
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

  return {
    currency: [...currencies][0] || null,
    // Purchases + their value come from the same `actions`/`action_values` payload; a
    // pixel that isn't reporting yields nulls per row, which roll up as 0 — so we only
    // claim support when at least one row actually carried a purchase action.
    supports: {
      purchases: rows.some((r) => r.purchases != null),
      revenue: rows.some((r) => r.revenue != null),
      budget: false,
    },
    rows,
    notes,
    accounts: cfg.ids,
  };
}
