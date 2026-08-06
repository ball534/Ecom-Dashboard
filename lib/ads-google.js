// lib/ads-google.js
// Google Ads API — daily campaign metrics via GAQL over googleAds:searchStream.
//
// Auth is OAuth2 with a refresh token belonging to a user who can read the MCC:
//   GOOGLE_ADS_DEVELOPER_TOKEN        from API Center (needs at least Basic access)
//   GOOGLE_ADS_CLIENT_ID / _SECRET    the Google Cloud OAuth client
//   GOOGLE_ADS_REFRESH_TOKEN          offline refresh token for an MCC reader
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID      the MCC id (digits; dashes are stripped)
//   GOOGLE_ADS_CUSTOMER_<STORE>       the account being reported on (_SG/_MY accepted
//                                     for the two iORA stores; comma-separate several)
//   GOOGLE_ADS_API_VERSION            default below — bump when Google sunsets it
//
// Refresh tokens don't rotate, so the access token is simply minted per cold start and
// cached in module scope for its lifetime — no durable token store needed (contrast
// lib/shopee.js, whose refresh token DOES rotate).

import { ApiError, requestJSON } from "./http.js";
import { envCred, envId } from "./env-keys.js";

const DEFAULT_VERSION = "v21";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const digits = (s) => String(s || "").replace(/[^0-9]/g, "");

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

export function googleConfig(env, brand) {
  const devToken = envCred(env, "GOOGLE_ADS_DEVELOPER_TOKEN", brand);
  const clientId = envCred(env, "GOOGLE_ADS_CLIENT_ID", brand);
  const clientSecret = envCred(env, "GOOGLE_ADS_CLIENT_SECRET", brand);
  const refreshToken = envCred(env, "GOOGLE_ADS_REFRESH_TOKEN", brand);
  const loginCustomer = envCred(env, "GOOGLE_ADS_LOGIN_CUSTOMER_ID", brand);
  const customers = envId(env, "GOOGLE_ADS_CUSTOMER", brand);
  return {
    devToken: devToken.value,
    devTokenName: devToken.name,
    clientId: clientId.value,
    clientSecret: clientSecret.value,
    refreshToken: refreshToken.value,
    loginCustomer: digits(loginCustomer.value),
    ids: customers.value.split(",").map(digits).filter(Boolean),
    customerName: customers.name,
    version: (env.GOOGLE_ADS_API_VERSION || DEFAULT_VERSION).trim(),
  };
}

// Access tokens live an hour; cache per credential set so a warm instance mints one.
const tokenCache = new Map(); // clientId|refreshToken -> { token, expires }

export function clearGoogleTokenCache() {
  tokenCache.clear();
}

async function accessToken(cfg) {
  const key = `${cfg.clientId}|${cfg.refreshToken}`;
  const hit = tokenCache.get(key);
  if (hit && hit.expires > Date.now() + 60000) return hit.token;

  const json = await requestJSON(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
    label: "Google OAuth token",
    retries: 1,
    accept: (j) => {
      if (j?.error) {
        throw new ApiError("auth", `Google OAuth: ${j.error_description || j.error}`);
      }
    },
  });
  const token = json?.access_token;
  if (!token) throw new ApiError("auth", "Google OAuth returned no access_token");
  tokenCache.set(key, {
    token,
    expires: Date.now() + Math.max(60, Number(json.expires_in) || 3600) * 1000,
  });
  return token;
}

// Campaign × day. `metrics.conversions` counts every conversion action the account
// counts as a conversion — Google has no single "purchases" metric — so it feeds the
// purchase/value columns and the Ads tab labels Google's table without a Purchases row.
const GAQL = (start, end) => `
SELECT campaign.id, campaign.name, segments.date, customer.currency_code,
       metrics.cost_micros, metrics.impressions, metrics.clicks,
       metrics.conversions, metrics.conversions_value
FROM campaign
WHERE segments.date BETWEEN '${start}' AND '${end}'`;

function googleAccept(json) {
  // searchStream returns an ARRAY of chunks on success; an object means an error body.
  if (Array.isArray(json)) return;
  const err = json?.error || json?.[0]?.error;
  if (!err) return;
  const msg = String(err.message || "Google Ads API error");
  const status = String(err.status || "");
  if (/UNAUTHENTICATED/.test(status)) throw new ApiError("auth", msg);
  if (/PERMISSION_DENIED/.test(status)) throw new ApiError("scope", msg);
  if (/RESOURCE_EXHAUSTED|QUOTA/.test(status)) throw new ApiError("throttle", msg);
  throw new ApiError("api", msg);
}

// Google returns fields camelCased in JSON (costMicros) but GAQL names them snake_cased.
const field = (obj, camel, snake) => (obj?.[camel] !== undefined ? obj[camel] : obj?.[snake]);

async function fetchCustomer(cfg, token, customerId, { start, end, deadline }) {
  if (deadline) deadline.check(`Google Ads ${customerId}`);
  const url = `https://googleads.googleapis.com/${cfg.version}/customers/${customerId}/googleAds:searchStream`;
  const json = await requestJSON(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "developer-token": cfg.devToken,
      "Content-Type": "application/json",
      ...(cfg.loginCustomer ? { "login-customer-id": cfg.loginCustomer } : {}),
    },
    body: JSON.stringify({ query: GAQL(start, end) }),
    label: `Google Ads (${customerId})`,
    accept: googleAccept,
    timeoutMs: 30000,
  });

  const rows = [];
  let currency = null;
  for (const chunk of Array.isArray(json) ? json : []) {
    for (const r of chunk?.results || []) {
      const m = r.metrics || {};
      const seg = r.segments || {};
      if (!currency && r.customer) currency = field(r.customer, "currencyCode", "currency_code") || null;
      rows.push({
        date: String(seg.date || "").slice(0, 10),
        campaignId: r.campaign?.id != null ? String(r.campaign.id) : null,
        campaign: r.campaign?.name || null,
        spend: num(field(m, "costMicros", "cost_micros")) / 1e6,
        impressions: num(m.impressions),
        clicks: num(m.clicks),
        purchases: num(m.conversions),
        revenue: num(field(m, "conversionsValue", "conversions_value")),
      });
    }
  }
  return { rows, currency };
}

/** Daily campaign rows for one brand, in lib/ads.js's provider contract. */
export async function fetchGoogleAds(env, brand, { start, end, deadline } = {}) {
  const cfg = googleConfig(env, brand);
  const missing = [];
  if (!cfg.devToken) missing.push(cfg.devTokenName);
  if (!cfg.clientId) missing.push("GOOGLE_ADS_CLIENT_ID");
  if (!cfg.clientSecret) missing.push("GOOGLE_ADS_CLIENT_SECRET");
  if (!cfg.refreshToken) missing.push("GOOGLE_ADS_REFRESH_TOKEN");
  if (!cfg.ids.length) missing.push(cfg.customerName);
  if (missing.length) {
    throw new ApiError(
      "not-configured",
      `Google Ads are not configured for brand "${brand}". Missing: ${missing.join(", ")}.`,
    );
  }

  const token = await accessToken(cfg);
  const rows = [];
  const currencies = new Set();
  for (const id of cfg.ids) {
    const r = await fetchCustomer(cfg, token, id, { start, end, deadline });
    rows.push(...r.rows);
    if (r.currency) currencies.add(r.currency);
  }
  if (currencies.size > 1) {
    throw new ApiError(
      "api",
      `Google Ads customers for "${brand}" report different currencies ` +
        `(${[...currencies].join(", ")}) — they cannot be added together.`,
    );
  }

  return {
    currency: [...currencies][0] || null,
    supports: {
      // Conversions are always returned (0 when there are none), so they are supported
      // whenever any row came back at all.
      purchases: rows.length > 0,
      revenue: rows.length > 0,
      budget: false,
    },
    rows,
    notes: [
      "Google figures use metrics.conversions / conversions_value — every action the " +
        "account counts as a conversion, not purchases alone.",
    ],
    accounts: cfg.ids,
  };
}
