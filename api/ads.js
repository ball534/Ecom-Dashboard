// api/ads.js
// Vercel serverless endpoint behind the dashboard's Ads tab. One round trip per brand
// per year returns all three ad platforms — Meta, Google and TikTok — in the shapes the
// tab already renders (ADS[platform][brand] and CAMPAIGNS[platform][brand]).
//
// Query params:
//   ?brand=SG&start=YYYY-MM-DD&end=YYYY-MM-DD   (defaults to the current year to date)
//
// The Ads tab labels its columns by month name alone, so a pull covers ONE calendar
// year: a range spanning years is clamped to its end year and the clamp is reported in
// meta.range.clamped rather than silently merging two Januaries.
//
// Every response is HTTP 200. Platforms are independent and best-effort: a failure nulls
// that platform and records why in meta.platforms.<key>, exactly like the per-section
// convention in /api/dashboard and /api/insights. A platform with no credentials is
// `reason:"not-configured"` — an honest blank, never an error.

import {
  buildPlatformSeries,
  buildCampaignRows,
  resolveAdsYear,
  AD_PLATFORMS,
} from "../lib/ads.js";
import { fetchMetaAds } from "../lib/ads-meta.js";
import { fetchGoogleAds } from "../lib/ads-google.js";
import { fetchTiktokAds, fetchTiktokCurrency } from "../lib/ads-tiktok.js";
import { settledPool, failInfo, deadline } from "../lib/http.js";
import { normalizeBrand, currencyOf } from "../lib/env-keys.js";
import { todayInTZ } from "../lib/aggregate.js";

const SHOP_TZ = "Asia/Singapore";
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// An UNSET or blank env var is not a target of zero: only a real number counts.
function numEnv(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const FETCHERS = {
  fb: fetchMetaAds,
  google: fetchGoogleAds,
  tiktok: fetchTiktokAds,
};

export default async function handler(req, res) {
  const today = todayInTZ(SHOP_TZ);
  const q = req.query || {};
  const brand = normalizeBrand(q.brand);

  let start = isDate(q.start) ? q.start : `${today.slice(0, 4)}-01-01`;
  let end = isDate(q.end) ? q.end : today;
  if (start > end) [start, end] = [end, start];
  const range = resolveAdsYear(start, end);

  // 50s of the function's 60s ceiling (vercel.json) is handed to the platform pulls, so
  // a slow provider fails its own section with reason:"timeout" instead of 504-ing the
  // payload. Meta needs most of it: its insights work is an async job Meta computes
  // server-side, measured 21 Aug 2026 at ~25s to compute a year of dailies plus ~5s per
  // 1000-row results page — ~36s for iORA SG's 1,114 rows. The remaining 10s covers
  // rolling the rows up and serialising the response.
  const budget = deadline(50000);

  const results = await settledPool(
    AD_PLATFORMS.map(
      (key) => () =>
        FETCHERS[key](process.env, brand, {
          start: range.start,
          end: range.end,
          deadline: budget,
        }),
    ),
    3,
  );

  const platforms = {};
  const campaigns = {};
  const metaPlatforms = {};
  let live = false;

  AD_PLATFORMS.forEach((key, i) => {
    const r = results[i];
    if (r.status !== "fulfilled") {
      platforms[key] = null;
      campaigns[key] = null;
      metaPlatforms[key] = failInfo(r.reason);
      return;
    }
    const p = r.value;
    const series = buildPlatformSeries(p.rows, {
      year: range.year,
      supports: p.supports,
      currency: p.currency,
    });
    platforms[key] = series;
    campaigns[key] = series ? buildCampaignRows(p.rows, { year: range.year, supports: p.supports }) : null;
    metaPlatforms[key] = {
      ok: true,
      currency: p.currency || null,
      accounts: p.accounts || [],
      rows: Array.isArray(p.rows) ? p.rows.length : 0,
      months: series ? series.months.length : 0,
      supports: p.supports,
      notes: p.notes || [],
    };
    // A configured platform that simply had no spend in the window is still "live" —
    // it answered. That distinction is what stops the tab claiming "not connected".
    live = true;
  });

  // TikTok's report carries no currency column; fill it in separately so a MYR account
  // shown under an SGD store is visible rather than silently mixed.
  if (metaPlatforms.tiktok?.ok && !metaPlatforms.tiktok.currency) {
    try {
      const cur = await fetchTiktokCurrency(process.env, brand);
      if (cur) {
        metaPlatforms.tiktok.currency = cur;
        if (platforms.tiktok) platforms.tiktok.currency = cur;
      }
    } catch {
      // Labelling only — never fail the platform over it.
    }
  }

  const currencies = [
    ...new Set(
      AD_PLATFORMS.map((k) => metaPlatforms[k]?.currency).filter(Boolean),
    ),
  ];
  const expected = currencyOf(brand);

  const meta = {
    live,
    brand,
    asOf: new Date().toISOString(),
    range: { start: range.start, end: range.end, year: range.year, clamped: range.clamped },
    // The store's own currency, plus what the ad accounts actually report in. The tab
    // formats figures with the store's symbol, so a mismatch has to be shown, not fixed.
    storeCurrency: expected,
    // Optional, hand-set performance targets — the only hand-maintained numbers this
    // endpoint serves, and absent unless somebody configures them. No API reports a
    // target, and the tab hides its "vs target" chips rather than invent one.
    targets: { roas: numEnv(process.env.ADS_TARGET_ROAS), ctr: numEnv(process.env.ADS_TARGET_CTR) },
    currencies,
    currencyMismatch: currencies.length > 1 || (currencies.length === 1 && currencies[0] !== expected),
    platforms: metaPlatforms,
  };

  if (!live) {
    const firstFail = AD_PLATFORMS.map((k) => metaPlatforms[k]).find((m) => m && m.ok === false);
    const allUnconfigured = AD_PLATFORMS.every(
      (k) => metaPlatforms[k]?.reason === "not-configured",
    );
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      platforms,
      campaigns,
      meta: {
        ...meta,
        reason: allUnconfigured ? "not-configured" : firstFail?.reason || "no-data",
        message: firstFail?.message,
      },
    });
  }

  // Only a payload where every configured platform answered is edge-cached (5 min).
  // A transient failure must not be pinned at the edge; a deterministic one
  // (not-configured / scope) can be, or a missing token would make every response
  // uncacheable forever.
  const transient = AD_PLATFORMS.some((k) => {
    const m = metaPlatforms[k];
    return m && m.ok === false && ["throttle", "timeout", "http", "error"].includes(m.reason);
  });
  res.setHeader(
    "Cache-Control",
    transient ? "no-store" : "public, s-maxage=300, stale-while-revalidate=600",
  );
  return res.status(200).json({ platforms, campaigns, meta });
}
