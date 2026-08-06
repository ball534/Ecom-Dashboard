// lib/shopee.js
// Shopee Open Platform v2 — per-shop order pull for the Channel Mix panel and the
// marketplace half of the voucher report.
//
//   SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY        the app (shared across shops)
//   SHOPEE_SHOP_ID_<STORE>                        authorized shop (_SG/_MY for iORA)
//   SHOPEE_ACCESS_TOKEN_<STORE>                   seed token (4h life)
//   SHOPEE_REFRESH_TOKEN_<STORE>                  seed refresh token (30d life)
//   SHOPEE_HOST                                   default https://partner.shopeemobile.com
//   SHOPEE_ORDER_FIELDS                           optional override of the detail fields
//
// Token handling: Shopee ROTATES the refresh token on every refresh, so the current pair
// is kept in lib/token-store.js and the env vars are only ever the seed. Configure
// TOKEN_STORE_URL/_TOKEN in production — without it a redeploy falls back to the seed
// pair, which by then is spent.
//
// Signing (v2): HMAC-SHA256 over
//   shop API:   partner_id + api_path + timestamp + access_token + shop_id
//   public API: partner_id + api_path + timestamp
// keyed with the partner key, lower-case hex.

import { createHmac } from "node:crypto";
import { ApiError, requestJSON } from "./http.js";
import { envCred, envId } from "./env-keys.js";
import { loadToken, saveToken } from "./token-store.js";

const DEFAULT_HOST = "https://partner.shopeemobile.com";
const LIST_PATH = "/api/v2/order/get_order_list";
const DETAIL_PATH = "/api/v2/order/get_order_detail";
const TOKEN_PATH = "/api/v2/auth/access_token/get";

// The API caps a create_time window at 15 days and a detail call at 50 order_sn.
const WINDOW_DAYS = 15;
const DETAIL_CHUNK = 50;
const LIST_PAGE = 100;

// Orders that are not (yet) revenue. Shopee's terminal-good statuses are
// READY_TO_SHIP / PROCESSED / SHIPPED / TO_CONFIRM_RECEIVE / COMPLETED / RETRY_SHIP.
const NON_REVENUE_STATUS = new Set(["UNPAID", "CANCELLED", "INVOICE_PENDING"]);

// Order-level fields the pull needs. `voucher_code` / `seller_discount` are not offered
// by every API build, so a rejection falls back to the safe set and the voucher rows
// (not the revenue) are what goes missing.
const FIELDS_FULL = "total_amount,order_status,create_time,voucher_code,seller_discount";
const FIELDS_SAFE = "total_amount,order_status,create_time";

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

export function shopeeConfig(env, brand) {
  const partnerId = envCred(env, "SHOPEE_PARTNER_ID", brand);
  const partnerKey = envCred(env, "SHOPEE_PARTNER_KEY", brand);
  const shopId = envId(env, "SHOPEE_SHOP_ID", brand);
  const access = envCred(env, "SHOPEE_ACCESS_TOKEN", brand);
  const refresh = envCred(env, "SHOPEE_REFRESH_TOKEN", brand);
  return {
    partnerId: String(partnerId.value || "").trim(),
    partnerKey: partnerKey.value,
    shopId: String(shopId.value || "").trim(),
    shopIdName: shopId.name,
    seedAccess: access.value,
    seedRefresh: refresh.value,
    host: String(env.SHOPEE_HOST || DEFAULT_HOST).trim().replace(/\/$/, ""),
    fields: String(env.SHOPEE_ORDER_FIELDS || "").trim(),
  };
}

function sign(cfg, path, timestamp, { accessToken = "", shopId = "" } = {}) {
  const base = `${cfg.partnerId}${path}${timestamp}${accessToken}${shopId}`;
  return createHmac("sha256", cfg.partnerKey).update(base).digest("hex");
}

// Shopee answers HTTP 200 with {error:"", message:""} on success; a non-empty `error`
// string is the real status.
function shopeeAccept(json) {
  const code = String(json?.error || "");
  if (!code) return;
  const msg = String(json.message || code);
  if (/token|auth/i.test(code)) throw new ApiError("auth", `Shopee ${code}: ${msg}`);
  if (/rate|frequen/i.test(code)) throw new ApiError("throttle", `Shopee ${code}: ${msg}`);
  if (/permission|scope/i.test(code)) throw new ApiError("scope", `Shopee ${code}: ${msg}`);
  throw new ApiError("api", `Shopee ${code}: ${msg}`);
}

async function refreshAccessToken(cfg, refreshToken, env) {
  const ts = Math.floor(Date.now() / 1000);
  const json = await requestJSON(`${cfg.host}${TOKEN_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    query: { partner_id: cfg.partnerId, timestamp: ts, sign: sign(cfg, TOKEN_PATH, ts) },
    body: JSON.stringify({
      refresh_token: refreshToken,
      partner_id: Number(cfg.partnerId),
      shop_id: Number(cfg.shopId),
    }),
    label: "Shopee token refresh",
    retries: 1,
    accept: shopeeAccept,
  });
  if (!json?.access_token || !json?.refresh_token) {
    throw new ApiError("auth", "Shopee token refresh returned no token pair");
  }
  const pair = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    // expire_in is seconds (typically 14400). Renew a minute early.
    expires_at: Date.now() + Math.max(60, Number(json.expire_in) || 14400) * 1000 - 60000,
  };
  await saveToken(`shopee:${cfg.shopId}`, pair, env);
  return pair;
}

/**
 * A usable access token for this shop: the stored one while it lasts, otherwise a
 * refresh using the stored refresh token (falling back to the seed from the env).
 */
export async function shopeeAccessToken(cfg, env) {
  const stored = await loadToken(`shopee:${cfg.shopId}`, env);
  if (stored?.access_token && stored.expires_at > Date.now()) return stored.access_token;

  const refreshToken = stored?.refresh_token || cfg.seedRefresh;
  if (refreshToken) {
    try {
      const pair = await refreshAccessToken(cfg, refreshToken, env);
      return pair.access_token;
    } catch (e) {
      // A spent refresh token is a real, actionable failure — but if a seed access token
      // is present it may still be inside its 4-hour life, so try it before giving up.
      if (!cfg.seedAccess) {
        throw new ApiError(
          "auth",
          `${e.message}. Re-authorize the shop and update SHOPEE_REFRESH_TOKEN — and set ` +
            `TOKEN_STORE_URL/_TOKEN so rotated tokens persist.`,
        );
      }
    }
  }
  if (cfg.seedAccess) return cfg.seedAccess;
  throw new ApiError("not-configured", "No Shopee access or refresh token for this shop");
}

const dayStart = (d) => Math.floor(new Date(`${d}T00:00:00+08:00`).getTime() / 1000);
const dayEnd = (d) => Math.floor(new Date(`${d}T23:59:59+08:00`).getTime() / 1000);

/** [start, end] split into ≤15-day epoch-second windows (SGT/MYT are both UTC+8). */
export function shopeeWindows(start, end) {
  const out = [];
  const from = new Date(`${start}T00:00:00Z`);
  const to = new Date(`${end}T00:00:00Z`);
  for (let cur = from; cur <= to; ) {
    const next = new Date(cur);
    next.setUTCDate(next.getUTCDate() + WINDOW_DAYS - 1);
    const stop = next > to ? to : next;
    out.push({
      time_from: dayStart(cur.toISOString().slice(0, 10)),
      time_to: dayEnd(stop.toISOString().slice(0, 10)),
    });
    cur = new Date(stop);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

async function call(cfg, token, path, query, label, deadline) {
  if (deadline) deadline.check(label);
  const ts = Math.floor(Date.now() / 1000);
  return requestJSON(`${cfg.host}${path}`, {
    query: {
      partner_id: cfg.partnerId,
      timestamp: ts,
      access_token: token,
      shop_id: cfg.shopId,
      sign: sign(cfg, path, ts, { accessToken: token, shopId: cfg.shopId }),
      ...query,
    },
    label,
    accept: shopeeAccept,
    timeoutMs: 20000,
  });
}

/**
 * Every order created in [start, end] for this brand's Shopee shop, normalized to
 * { id, date, total, discount, voucherCode, status, cancelled }.
 *
 * The pull either completes or throws: a half-paged month would understate a channel's
 * revenue, which is a wrong number rather than a missing one.
 */
export async function fetchShopeeOrders(env, brand, { start, end, deadline } = {}) {
  const cfg = shopeeConfig(env, brand);
  const missing = [];
  if (!cfg.partnerId) missing.push("SHOPEE_PARTNER_ID");
  if (!cfg.partnerKey) missing.push("SHOPEE_PARTNER_KEY");
  if (!cfg.shopId) missing.push(cfg.shopIdName);
  if (!cfg.seedAccess && !cfg.seedRefresh) missing.push(`SHOPEE_REFRESH_TOKEN_…`);
  if (missing.length) {
    throw new ApiError(
      "not-configured",
      `Shopee is not configured for brand "${brand}". Missing: ${missing.join(", ")}.`,
    );
  }

  const token = await shopeeAccessToken(cfg, env);
  const notes = [];

  // 1. order_sn list, per 15-day window.
  const sns = [];
  for (const w of shopeeWindows(start, end)) {
    let cursor = "";
    for (let page = 0; page < 200; page++) {
      const json = await call(
        cfg,
        token,
        LIST_PATH,
        {
          time_range_field: "create_time",
          time_from: w.time_from,
          time_to: w.time_to,
          page_size: LIST_PAGE,
          cursor,
          response_optional_fields: "order_status",
        },
        "Shopee order list",
        deadline,
      );
      const resp = json?.response || {};
      for (const o of resp.order_list || []) if (o?.order_sn) sns.push(o.order_sn);
      if (!resp.more) break;
      cursor = resp.next_cursor || "";
      if (!cursor) break;
    }
  }
  if (!sns.length) return { orders: [], notes, shopId: cfg.shopId };

  // 2. order details, 50 at a time (this is where the money lives).
  let fields = cfg.fields || FIELDS_FULL;
  let vouchersAvailable = /voucher_code/.test(fields);
  const orders = [];
  for (let i = 0; i < sns.length; i += DETAIL_CHUNK) {
    const chunk = sns.slice(i, i + DETAIL_CHUNK);
    let json;
    try {
      json = await call(
        cfg,
        token,
        DETAIL_PATH,
        { order_sn_list: chunk.join(","), response_optional_fields: fields },
        "Shopee order detail",
        deadline,
      );
    } catch (e) {
      const fieldProblem =
        e instanceof ApiError && e.reason === "api" && /field|param/i.test(e.message);
      if (!fieldProblem || fields === FIELDS_SAFE) throw e;
      notes.push(
        `Shopee rejected the optional fields (${e.message}); retried without voucher fields, ` +
          `so Shopee voucher rows are unavailable (revenue is unaffected).`,
      );
      fields = FIELDS_SAFE;
      vouchersAvailable = false;
      i -= DETAIL_CHUNK; // redo this chunk with the safe field set
      continue;
    }
    for (const o of json?.response?.order_list || []) {
      const status = String(o?.order_status || "").toUpperCase();
      orders.push({
        id: String(o?.order_sn || ""),
        // create_time is epoch seconds; both markets report in UTC+8.
        date: new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Singapore",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(num(o?.create_time) * 1000)),
        total: num(o?.total_amount),
        discount: o?.seller_discount != null ? num(o.seller_discount) : null,
        voucherCode: o?.voucher_code ? String(o.voucher_code) : null,
        status,
        cancelled: NON_REVENUE_STATUS.has(status),
      });
    }
  }
  return { orders, notes, shopId: cfg.shopId, vouchersAvailable };
}

// Test seam — see lib/lazada.js.
export { sign as shopeeSignForTest };
