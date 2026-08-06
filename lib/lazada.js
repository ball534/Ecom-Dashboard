// lib/lazada.js
// Lazada Open Platform — per-seller order pull for the Channel Mix panel and the
// marketplace half of the voucher report.
//
//   LAZADA_APP_KEY / LAZADA_APP_SECRET            the app (shared across sellers)
//   LAZADA_ACCESS_TOKEN_<STORE>                   seed token (_SG/_MY accepted for iORA)
//   LAZADA_REFRESH_TOKEN_<STORE>                  seed refresh token
//   LAZADA_HOST[_<STORE>]                         default per market (api.lazada.sg /
//                                                 api.lazada.com.my)
//
// Like Shopee, Lazada rotates the refresh token, so the live pair lives in
// lib/token-store.js and the env vars are only the seed. Unlike Shopee, /orders/get
// returns the order total (`price`) directly, so one paged call per window is enough —
// no per-order detail round trip.
//
// Signing: HMAC-SHA256(app_secret, api_path + Σ(sorted key+value)) in UPPER-case hex,
// where the params include the system ones (app_key, timestamp, sign_method,
// access_token) but never `sign` itself.

import { createHmac } from "node:crypto";
import { ApiError, requestJSON } from "./http.js";
import { envCred, envId, marketOf } from "./env-keys.js";
import { loadToken, saveToken } from "./token-store.js";

const HOSTS = { SG: "https://api.lazada.sg/rest", MY: "https://api.lazada.com.my/rest" };
const ORDERS_PATH = "/orders/get";
const REFRESH_PATH = "/auth/token/refresh";
const PAGE = 100;
const MAX_PAGES = 300;

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

export function lazadaConfig(env, brand) {
  const appKey = envCred(env, "LAZADA_APP_KEY", brand);
  const appSecret = envCred(env, "LAZADA_APP_SECRET", brand);
  const access = envId(env, "LAZADA_ACCESS_TOKEN", brand);
  const refresh = envId(env, "LAZADA_REFRESH_TOKEN", brand);
  const host = envCred(env, "LAZADA_HOST", brand);
  const market = marketOf(brand);
  return {
    appKey: appKey.value,
    appSecret: appSecret.value,
    seedAccess: access.value,
    accessName: access.name,
    seedRefresh: refresh.value,
    host: (host.value || HOSTS[market]).replace(/\/$/, ""),
    market,
    // One store per seller account, so the token is keyed by app + store.
    storeKey: `lazada:${brand}`,
  };
}

function sign(cfg, path, params) {
  const keys = Object.keys(params).filter((k) => k !== "sign").sort();
  const base = path + keys.map((k) => `${k}${params[k]}`).join("");
  return createHmac("sha256", cfg.appSecret).update(base).digest("hex").toUpperCase();
}

// Lazada answers HTTP 200 with a string `code`; "0" is success.
function lazadaAccept(json) {
  const code = String(json?.code ?? "");
  if (!code || code === "0") return;
  const msg = String(json.message || json.detail || code);
  if (/token/i.test(code) || /token/i.test(msg)) throw new ApiError("auth", `Lazada ${code}: ${msg}`);
  if (/ApiCallLimit|Throttle|Flow/i.test(code)) throw new ApiError("throttle", `Lazada ${code}: ${msg}`);
  if (/Permission|Authoriz/i.test(code)) throw new ApiError("scope", `Lazada ${code}: ${msg}`);
  throw new ApiError("api", `Lazada ${code}: ${msg}`);
}

async function callLazada(cfg, path, params, { token, label, deadline } = {}) {
  if (deadline) deadline.check(label || path);
  const all = {
    app_key: cfg.appKey,
    timestamp: String(Date.now()),
    sign_method: "sha256",
    ...(token ? { access_token: token } : {}),
    ...params,
  };
  all.sign = sign(cfg, path, all);
  return requestJSON(`${cfg.host}${path}`, {
    query: all,
    label: label || `Lazada ${path}`,
    accept: lazadaAccept,
    timeoutMs: 20000,
  });
}

async function refreshAccessToken(cfg, refreshToken, env) {
  const json = await callLazada(cfg, REFRESH_PATH, { refresh_token: refreshToken }, {
    label: "Lazada token refresh",
  });
  if (!json?.access_token) throw new ApiError("auth", "Lazada token refresh returned no token");
  const pair = {
    access_token: json.access_token,
    refresh_token: json.refresh_token || refreshToken,
    // expires_in is seconds (access tokens are short-lived; refresh tokens ~30 days).
    expires_at: Date.now() + Math.max(60, num(json.expires_in) || 604800) * 1000 - 60000,
  };
  await saveToken(cfg.storeKey, pair, env);
  return pair;
}

export async function lazadaAccessToken(cfg, env) {
  const stored = await loadToken(cfg.storeKey, env);
  if (stored?.access_token && stored.expires_at > Date.now()) return stored.access_token;

  const refreshToken = stored?.refresh_token || cfg.seedRefresh;
  if (refreshToken) {
    try {
      const pair = await refreshAccessToken(cfg, refreshToken, env);
      return pair.access_token;
    } catch (e) {
      if (!cfg.seedAccess) {
        throw new ApiError(
          "auth",
          `${e.message}. Re-authorize the seller account and update ${cfg.accessName} / ` +
            `LAZADA_REFRESH_TOKEN_… — and set TOKEN_STORE_URL/_TOKEN so rotated tokens persist.`,
        );
      }
    }
  }
  if (cfg.seedAccess) return cfg.seedAccess;
  throw new ApiError("not-configured", "No Lazada access or refresh token for this store");
}

// Lazada wants ISO-8601 with an offset, and both markets trade in UTC+8.
const isoStart = (d) => `${d}T00:00:00+08:00`;
const isoEnd = (d) => `${d}T23:59:59+08:00`;

// "2026-01-31 12:00:00 +0800" | ISO — take the calendar date as reported (UTC+8).
function orderDate(raw) {
  const s = String(raw || "");
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

const CANCELLED = new Set(["canceled", "cancelled", "unpaid", "failed"]);

/**
 * Every order created in [start, end] for this brand's Lazada seller account,
 * normalized to { id, date, total, discount, voucherCode, status, cancelled }.
 * Completes or throws — never a partial page (see lib/shopee.js for why).
 */
export async function fetchLazadaOrders(env, brand, { start, end, deadline } = {}) {
  const cfg = lazadaConfig(env, brand);
  const missing = [];
  if (!cfg.appKey) missing.push("LAZADA_APP_KEY");
  if (!cfg.appSecret) missing.push("LAZADA_APP_SECRET");
  if (!cfg.seedAccess && !cfg.seedRefresh) missing.push(cfg.accessName);
  if (missing.length) {
    throw new ApiError(
      "not-configured",
      `Lazada is not configured for brand "${brand}". Missing: ${missing.join(", ")}.`,
    );
  }

  const token = await lazadaAccessToken(cfg, env);
  const orders = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await callLazada(
      cfg,
      ORDERS_PATH,
      {
        created_after: isoStart(start),
        created_before: isoEnd(end),
        sort_by: "created_at",
        sort_direction: "ASC",
        offset,
        limit: PAGE,
      },
      { token, label: "Lazada orders", deadline },
    );
    const list = json?.data?.orders || [];
    for (const o of list) {
      const statuses = (Array.isArray(o?.statuses) ? o.statuses : []).map((s) =>
        String(s).toLowerCase(),
      );
      orders.push({
        id: String(o?.order_id ?? o?.order_number ?? ""),
        date: orderDate(o?.created_at),
        total: num(o?.price),
        discount: o?.voucher != null ? num(o.voucher) : null,
        voucherCode: o?.voucher_code ? String(o.voucher_code) : null,
        status: statuses.join("/"),
        // An order every one of whose statuses is cancelled/unpaid is not revenue.
        cancelled: statuses.length > 0 && statuses.every((s) => CANCELLED.has(s)),
      });
    }
    if (list.length < PAGE) break;
    offset += PAGE;
    if (page === MAX_PAGES - 1) {
      throw new ApiError(
        "api",
        `Lazada orders: more than ${MAX_PAGES * PAGE} orders in the window — refusing to serve a ` +
          `truncated total.`,
      );
    }
  }
  return { orders, notes: [], vouchersAvailable: true };
}

// Test seam: the signing algorithm is the part most likely to break silently, so it is
// exported for scripts/test.js to verify against an independently computed HMAC.
export { sign as lazadaSignForTest };
