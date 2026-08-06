// lib/ads-tiktok.js
// TikTok Business (Ads) API — daily campaign rows from /report/integrated/get/.
//
//   TIKTOK_ACCESS_TOKEN[_<STORE>|_<MARKET>]  long-term token from the authorized app
//   TIKTOK_ADVERTISER_<STORE>                advertiser id (_SG/_MY accepted for iORA;
//                                            comma-separate several)
//   TIKTOK_API_VERSION                       default v1.3
//   TIKTOK_METRICS                           optional comma-separated override
//   TIKTOK_REVENUE_METRIC                    optional: a metric that IS purchase value
//                                            in your account, used verbatim if set
//
// TikTok's metric vocabulary changes between API versions, and it has no single
// "purchase value" metric that is stable across them. Rather than guess, this client
// requests only metrics whose names are unambiguous, then derives revenue from the
// first arithmetic that is fully supported by the data returned:
//
//   1. TIKTOK_REVENUE_METRIC, if set                (verbatim, no arithmetic)
//   2. value_per_complete_payment × complete_payment
//   3. complete_payment_roas × spend
//   4. otherwise revenue stays NULL and the tab shows "—"
//
// Whichever applies is recorded in `notes`, so a reader can always tell how the ROAS
// column was produced. If the API rejects the metric list outright, the request is
// retried with the core three (spend/impressions/clicks) so at least spend is real.

import { ApiError, requestJSON } from "./http.js";
import { envCred, envId } from "./env-keys.js";

const DEFAULT_VERSION = "v1.3";
const PAGE_SIZE = 1000;
const MAX_PAGES = 40;

const CORE_METRICS = ["campaign_name", "spend", "impressions", "clicks"];
const OPTIONAL_METRICS = [
  "conversion",
  "complete_payment",
  "value_per_complete_payment",
  "complete_payment_roas",
];

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const has = (m, k) => m && m[k] !== undefined && m[k] !== null && m[k] !== "";

export function tiktokConfig(env, brand) {
  const token = envCred(env, "TIKTOK_ACCESS_TOKEN", brand);
  const advertisers = envId(env, "TIKTOK_ADVERTISER", brand);
  const override = String(env.TIKTOK_METRICS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const revenueMetric = String(env.TIKTOK_REVENUE_METRIC || "").trim();
  return {
    token: token.value,
    tokenName: token.name,
    ids: advertisers.value.split(",").map((s) => s.trim()).filter(Boolean),
    advertiserName: advertisers.name,
    version: (env.TIKTOK_API_VERSION || DEFAULT_VERSION).trim(),
    metrics: override.length
      ? override
      : [...CORE_METRICS, ...OPTIONAL_METRICS, ...(revenueMetric ? [revenueMetric] : [])],
    revenueMetric,
  };
}

// TikTok always answers HTTP 200 and puts the real status in `code` (0 = OK).
function tiktokAccept(json) {
  const code = Number(json?.code);
  if (!json || code === 0) return;
  const msg = String(json.message || `TikTok API error ${code}`);
  if (code === 40100 || code === 40101 || code === 40105 || /token/i.test(msg)) {
    throw new ApiError("auth", msg);
  }
  if (code === 40001 && /permission|scope/i.test(msg)) throw new ApiError("scope", msg);
  if (/rate limit|too frequent|qps/i.test(msg)) throw new ApiError("throttle", msg);
  throw new ApiError("api", msg);
}

async function fetchReport(cfg, advertiserId, metrics, { start, end, deadline }) {
  const base = `https://business-api.tiktok.com/open_api/${cfg.version}/report/integrated/get/`;
  const list = [];
  let page = 1;
  for (; page <= MAX_PAGES; page++) {
    if (deadline) deadline.check(`TikTok ${advertiserId}`);
    const json = await requestJSON(base, {
      headers: { "Access-Token": cfg.token },
      query: {
        advertiser_id: advertiserId,
        report_type: "BASIC",
        data_level: "AUCTION_CAMPAIGN",
        dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
        metrics: JSON.stringify(metrics),
        start_date: start,
        end_date: end,
        page,
        page_size: PAGE_SIZE,
      },
      label: `TikTok report (${advertiserId})`,
      accept: tiktokAccept,
      timeoutMs: 25000,
    });
    const data = json?.data || {};
    list.push(...(Array.isArray(data.list) ? data.list : []));
    const totalPages = Number(data.page_info?.total_page || 1);
    if (page >= totalPages) break;
    if (page === MAX_PAGES) {
      throw new ApiError(
        "api",
        `TikTok report (${advertiserId}): more than ${MAX_PAGES} pages — refusing to serve a ` +
          `truncated series.`,
      );
    }
  }
  return list;
}

/** Daily campaign rows for one brand, in lib/ads.js's provider contract. */
export async function fetchTiktokAds(env, brand, { start, end, deadline } = {}) {
  const cfg = tiktokConfig(env, brand);
  if (!cfg.token || !cfg.ids.length) {
    throw new ApiError(
      "not-configured",
      `TikTok ads are not configured for brand "${brand}". Set ${cfg.advertiserName} and ` +
        `${cfg.tokenName}.`,
    );
  }

  const notes = [];
  let metrics = cfg.metrics;
  const raw = [];
  for (const id of cfg.ids) {
    let rows;
    try {
      rows = await fetchReport(cfg, id, metrics, { start, end, deadline });
    } catch (e) {
      // A rejected metric name is recoverable: fall back to the core three so spend,
      // impressions and clicks stay live and the conversion columns read "—".
      const metricProblem =
        e instanceof ApiError && e.reason === "api" && /metric|field|param/i.test(e.message);
      if (!metricProblem || metrics === CORE_METRICS) throw e;
      notes.push(
        `TikTok rejected the metric list (${e.message}); retried with spend/impressions/clicks ` +
          `only, so purchases and revenue are unavailable. Set TIKTOK_METRICS to this API ` +
          `version's names.`,
      );
      metrics = CORE_METRICS;
      rows = await fetchReport(cfg, id, metrics, { start, end, deadline });
    }
    raw.push(...rows);
  }

  // Which revenue arithmetic is available across the returned rows?
  const anyMetric = (k) => raw.some((r) => has(r?.metrics, k));
  let revenueMode = null;
  if (cfg.revenueMetric && anyMetric(cfg.revenueMetric)) revenueMode = "direct";
  else if (anyMetric("value_per_complete_payment") && anyMetric("complete_payment")) {
    revenueMode = "value_per_payment";
  } else if (anyMetric("complete_payment_roas")) revenueMode = "roas";

  const purchaseKey = anyMetric("complete_payment")
    ? "complete_payment"
    : anyMetric("conversion")
      ? "conversion"
      : null;

  if (revenueMode === "value_per_payment") {
    notes.push("TikTok revenue = value_per_complete_payment × complete_payment.");
  } else if (revenueMode === "roas") {
    notes.push("TikTok revenue = complete_payment_roas × spend (no value metric was returned).");
  } else if (revenueMode === "direct") {
    notes.push(`TikTok revenue read directly from ${cfg.revenueMetric}.`);
  } else {
    notes.push("TikTok returned no purchase-value metric, so revenue and ROAS show —.");
  }
  if (purchaseKey === "conversion") {
    notes.push("TikTok purchases use `conversion` (all optimisation events), not complete_payment.");
  }

  const rows = raw.map((r) => {
    const m = r?.metrics || {};
    const d = r?.dimensions || {};
    const spend = num(m.spend);
    const purchases = purchaseKey ? num(m[purchaseKey]) : null;
    let revenue = null;
    if (revenueMode === "direct") revenue = num(m[cfg.revenueMetric]);
    else if (revenueMode === "value_per_payment") {
      revenue = num(m.value_per_complete_payment) * num(m.complete_payment);
    } else if (revenueMode === "roas") revenue = num(m.complete_payment_roas) * spend;
    return {
      // stat_time_day comes back as "YYYY-MM-DD 00:00:00"
      date: String(d.stat_time_day || "").slice(0, 10),
      campaignId: d.campaign_id != null ? String(d.campaign_id) : null,
      campaign: m.campaign_name || null,
      spend,
      impressions: num(m.impressions),
      clicks: num(m.clicks),
      purchases,
      revenue,
    };
  });

  return {
    // TikTok's report has no currency column; the advertiser's currency is fetched
    // separately by the endpoint (best-effort) so a mismatch is still visible.
    currency: null,
    supports: {
      purchases: purchaseKey != null,
      revenue: revenueMode != null,
      budget: false,
    },
    rows,
    notes,
    accounts: cfg.ids,
  };
}

/**
 * Advertiser currency, best-effort and separate from the report call: it is only used to
 * label the figures, so a failure here must not fail the platform.
 */
export async function fetchTiktokCurrency(env, brand) {
  const cfg = tiktokConfig(env, brand);
  if (!cfg.token || !cfg.ids.length) return null;
  const json = await requestJSON(
    `https://business-api.tiktok.com/open_api/${cfg.version}/advertiser/info/`,
    {
      headers: { "Access-Token": cfg.token },
      query: { advertiser_ids: JSON.stringify(cfg.ids) },
      label: "TikTok advertiser info",
      accept: tiktokAccept,
      retries: 0,
      timeoutMs: 10000,
    },
  );
  const list = json?.data?.list || [];
  const currencies = [...new Set(list.map((a) => a?.currency).filter(Boolean))];
  return currencies.length === 1 ? currencies[0] : null;
}
