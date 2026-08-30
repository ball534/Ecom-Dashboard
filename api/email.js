// api/email.js
// Vercel serverless endpoint behind the dashboard's Dotdigital (email) card on the Ads
// tab. One round trip per brand per year returns that store's email sends in the shape
// the panel already renders (DOTD[brand].campaigns).
//
// Query params:
//   ?brand=SG&start=YYYY-MM-DD&end=YYYY-MM-DD   (defaults to the current year to date)
//
// WHY THIS IS NOT PART OF /api/ads
// api/ads.js hands 50 of its 60 seconds to Meta alone, whose insights job takes ~36s
// for a year of iORA SG. Email is a second multi-page pull with its own cold-start
// cost; sharing that budget would turn one slow source into a 504 for the whole tab.
// Separate function, separate ceiling, separate failure.
//
// Providers are chosen by brand, never merged: Dotdigital sends for iORA, SANS & SANS
// and The Restyle Trait across both markets; Klaviyo sends for the two MONOLOQ stores.
//
// Every response is HTTP 200. A brand with no credentials is `reason:"not-configured"`
// — an honest blank, never an error — exactly like the per-section convention in
// /api/dashboard, /api/insights and /api/ads.

import { resolveAdsYear } from "../lib/ads.js";
import { buildEmailSends, revenueSupported } from "../lib/email.js";
import { fetchDotdigitalEmail } from "../lib/email-dotdigital.js";
import { fetchKlaviyoEmail } from "../lib/email-klaviyo.js";
import { failInfo, deadline } from "../lib/http.js";
import { normalizeBrand, currencyOf } from "../lib/env-keys.js";
import { tokenStoreKind } from "../lib/token-store.js";
import { todayInTZ } from "../lib/aggregate.js";

const SHOP_TZ = "Asia/Singapore";
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Which platform a store sends from. Set here, explicitly, never inferred. */
const PROVIDERS = {
  SG: "dotdigital",
  MY: "dotdigital",
  TRTSG: "dotdigital",
  TRTMY: "dotdigital",
  SANSSG: "dotdigital",
  SANSMY: "dotdigital",
  MONOSG: "klaviyo",
  MONOMY: "klaviyo",
};

const FETCHERS = {
  dotdigital: fetchDotdigitalEmail,
  klaviyo: fetchKlaviyoEmail,
};

export default async function handler(req, res) {
  const today = todayInTZ(SHOP_TZ);
  const q = req.query || {};
  const brand = normalizeBrand(q.brand);

  let start = isDate(q.start) ? q.start : `${today.slice(0, 4)}-01-01`;
  let end = isDate(q.end) ? q.end : today;
  if (start > end) [start, end] = [end, start];
  // The panel labels its columns by month name alone, so a pull covers ONE calendar
  // year — same clamp, and same reason, as the Ads tab.
  const range = resolveAdsYear(start, end);

  const provider = PROVIDERS[brand] || "dotdigital";
  const budget = deadline(50000);

  const base = {
    live: false,
    brand,
    provider,
    asOf: new Date().toISOString(),
    range: { start: range.start, end: range.end, year: range.year, clamped: range.clamped },
    storeCurrency: currencyOf(brand),
    // Dotdigital's summary cache lives here. On "tmp" it does not survive a redeploy or
    // a second instance, so a cold year re-pays its ~700 calls — visible, not silent.
    tokenStore: tokenStoreKind(process.env),
  };

  let result;
  try {
    result = await FETCHERS[provider](process.env, brand, {
      start: range.start,
      end: range.end,
      deadline: budget,
    });
  } catch (e) {
    const info = failInfo(e);
    res.setHeader(
      "Cache-Control",
      ["throttle", "timeout", "http", "error", "api"].includes(info.reason)
        ? "no-store"
        : "public, s-maxage=300, stale-while-revalidate=600",
    );
    return res.status(200).json({ campaigns: null, meta: { ...base, ...info } });
  }

  // Whether this account attributes revenue at all is a property of the WINDOW, not of
  // any one send — see revenueSupported() in lib/email.js. Deciding it here keeps both
  // clients from each having to reason about it.
  const hasRevenue = revenueSupported(result.sends);
  const campaigns = buildEmailSends(result.sends, {
    year: range.year,
    supports: { revenue: hasRevenue },
  });

  const notes = [...(result.notes || [])];
  if (!hasRevenue && result.sends.length) {
    notes.push(
      "No send in this window reported attributed revenue or orders, so the Revenue, " +
        "Orders and AOV rows read — rather than 0. An email platform only attributes " +
        "these once its commerce/ROI tracking is connected to the store — check that " +
        "before reading this as a year of campaigns that sold nothing.",
    );
  }

  const currency = result.currency || null;
  const meta = {
    ...base,
    // A configured account that simply had no sends is still "live" — it answered.
    live: true,
    ok: true,
    currency,
    currencyMismatch: !!currency && currency !== base.storeCurrency,
    supports: { revenue: hasRevenue },
    account: result.account || null,
    sends: campaigns ? campaigns.length : 0,
    stats: result.stats || null,
    notes,
  };

  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  return res.status(200).json({ campaigns, meta });
}
