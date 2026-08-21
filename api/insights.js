// api/insights.js
// Vercel serverless endpoint behind the dashboard's "insight" sections: best sellers
// (by SKU + product title), discount-code performance (range + monthly), category mix
// (SKU-prefix map), traffic attribution (range + monthly referrers + landing pages),
// the conversion funnel, the voucher report, and manually-maintained sales targets.
// Companion to
// /api/dashboard (which serves the monthly metric series) — this one serves top-N
// tables for a window, in ONE round trip, so the front-end fetches both in parallel.
//
// Query params (optional):
//   ?brand=SG&start=YYYY-MM-DD&end=YYYY-MM-DD&limit=10   — limit clamped 1..50
//   ?only=<keys>    — run ONLY these INSIGHT_QUERIES keys (comma-separated)
//   ?except=<keys>  — run everything EXCEPT these keys
//
// `only`/`except` exist so the front-end can PARTITION the ten queries across two
// parallel requests instead of waiting on one serialized pool. The Promotions tab needs
// two of the ten (discountCodes + discountMonthly), and discountMonthly is last in the
// pool — so the tab used to wait through all five rounds AND the best-seller image
// lookup for data that was ready in round one. Partitioned, each half is a separate
// invocation with its own budget. Front-end callers must keep the two sets disjoint so
// no query is paid for twice.
//
// Every response is HTTP 200. Sections are BEST-EFFORT and independent: the ShopifyQL
// calls run through a width-2 pool (allSettled-shaped) and a failed call yields
// sections.<x> = null plus a reason in meta.sections.<key> — the payload never 500s.
// A section whose query was not part of THIS request is also null, so a caller merging
// two partitioned payloads must treat null as "not supplied", never as "empty".
// Targets come from lib/targets.js (local data, no Shopify) and are served even when
// the brand has no Shopify credentials.

import {
  resolveConfig,
  envNames,
  envSuffix,
  shopifyQL,
  fetchProductImagesByTitle,
  fetchDiscountTerms,
  ShopifyError,
} from "./_shopify.js";
import {
  INSIGHT_QUERIES,
  PRODUCT_TYPE_LIMIT,
  parseTopSkus,
  parseTopTitles,
  parseDiscountCodes,
  parseDiscountMonthly,
  parseReferrers,
  parseOrderReferrers,
  parseCampaigns,
  parseFunnel,
  parseTrafficMonthly,
  parseLandingPages,
  parseDiscountTerms,
  buildVoucherReport,
  parseCategoryMix,
} from "../lib/insights.js";
import { TARGETS, getTargets } from "../lib/targets.js";
import { todayInTZ } from "../lib/aggregate.js";
import { normalizeBrand } from "../lib/env-keys.js";
// Firing all ten insight queries at once trips Shopify's cost throttle — and takes down
// /api/dashboard's sales query alongside it, which is what blanks Sales Revenue to dashes.
import { settledPool } from "../lib/http.js";

const SHOP_TZ = "Asia/Singapore";
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

const failInfo = (e) => ({
  ok: false,
  reason: e instanceof ShopifyError ? e.reason : "error",
  message: String(e?.message || e).slice(0, 400),
});

export default async function handler(req, res) {
  const today = todayInTZ(SHOP_TZ);
  const q = req.query || {};
  const brand = normalizeBrand(q.brand);
  // Mints this store's short-lived token when it has no permanent TOKEN_ (api/_token.js).
  const cfg = await resolveConfig(process.env, brand);

  let start = isDate(q.start) ? q.start : `${today.slice(0, 4)}-01-01`;
  let end = isDate(q.end) ? q.end : today;
  if (start > end) [start, end] = [end, start];
  const limit = Math.min(50, Math.max(1, Number(q.limit) || 10));

  // Which of the ten queries this request runs. Unknown keys are ignored; a filter that
  // matches nothing runs nothing (and says so) rather than silently falling back to the
  // full — expensive — set.
  const keyList = (v) =>
    String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
  const onlyKeys = keyList(q.only);
  const exceptKeys = keyList(q.except);
  const queries = INSIGHT_QUERIES.filter(
    (spec) =>
      (!onlyKeys.length || onlyKeys.includes(spec.key)) && !exceptKeys.includes(spec.key),
  );

  const years = [];
  for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) years.push(y);

  // Targets are local data — resolved regardless of Shopify credentials. A malformed
  // hand-edit of lib/targets.js degrades to a per-section error, never a 500.
  // A partitioned request serves targets only when it asked for them, so the two halves
  // don't both claim the same section (harmless but misleading in meta).
  const wantTargets = !onlyKeys.length || onlyKeys.includes("targets");
  let targets = null;
  const metaSections = {};
  if (wantTargets) {
    try {
      targets = getTargets(TARGETS, brand, years);
      metaSections.targets = targets ? { ok: true } : { ok: false, reason: "no-targets" };
    } catch (e) {
      metaSections.targets = { ok: false, reason: "error", message: String(e?.message || e).slice(0, 400) };
    }
  }

  const emptySections = {
    bestSellers: null,
    discounts: null,
    categories: null,
    traffic: null,
    funnel: null,
    voucherReport: null,
    targets,
  };

  // A brand with no token/domain isn't an error — mirror api/dashboard.js exactly. A token
  // that could not be minted (cfg.tokenError) is reported with its own reason/message.
  if (!cfg.token || !cfg.domain || cfg.domain === "your-store.myshopify.com") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      sections: emptySections,
      meta: {
        live: false,
        brand,
        reason: cfg.tokenError ? cfg.tokenError.reason : "not-configured",
        message: cfg.tokenError
          ? String(cfg.tokenError.message).slice(0, 400)
          : `No Shopify credentials configured for brand "${brand}". Set ${envNames(brand).domain} plus ` +
            `either ${envNames(brand).token} or CLIENT_${envSuffix(brand)} + SECRET_${envSuffix(brand)} ` +
            `in the Vercel project's Environment Variables.`,
        sections: metaSections,
      },
    });
  }

  // A filter that selected no query at all: answer immediately rather than run the full
  // set the caller was explicitly trying to avoid.
  if (!queries.length) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      sections: emptySections,
      meta: {
        live: false,
        brand,
        reason: "no-sections",
        message: `only=${q.only || ""} / except=${q.except || ""} selected none of the ` +
          `available sections (${INSIGHT_QUERIES.map((s) => s.key).join(", ")}).`,
        sections: metaSections,
      },
    });
  }

  try {
    const results = await settledPool(
      queries.map((spec) => () => shopifyQL(cfg, spec.build(start, end, limit))),
      2,
    );
    const rowsByKey = {};
    queries.forEach((spec, i) => {
      const r = results[i];
      if (r.status === "fulfilled") {
        rowsByKey[spec.key] = r.value.rows;
        metaSections[spec.key] = { ok: true };
      } else {
        rowsByKey[spec.key] = null;
        metaSections[spec.key] = failInfo(r.reason);
      }
    });

    const skuRows = rowsByKey.skuSales;
    const bySku = skuRows ? parseTopSkus(skuRows, limit) : null;
    const byTitle = rowsByKey.titleSales ? parseTopTitles(rowsByKey.titleSales, limit) : null;

    // Best-effort image lookup for the top titles (the gallery's photos). Runs after
    // the ShopifyQL pool so it never competes with the sales queries for cost budget.
    let images = null;
    if (byTitle && byTitle.length) {
      try {
        images = await fetchProductImagesByTitle(cfg, byTitle.map((p) => p.title));
        metaSections.productImages = { ok: true, resolved: Object.keys(images).length };
      } catch (e) {
        metaSections.productImages = failInfo(e);
      }
    }

    // Category mix from Shopify's own product_type. Null when the store sets no
    // product_type in the range — the panel then shows an empty state instead of a mix
    // invented from SKU naming, which is what it used to do.
    const categories = rowsByKey.productTypes ? parseCategoryMix(rowsByKey.productTypes) : null;
    if (categories) categories.truncated = rowsByKey.productTypes.length >= PRODUCT_TYPE_LIMIT;

    const referrers = rowsByKey.referrers ? parseReferrers(rowsByKey.referrers) : null;
    const orderReferrers = rowsByKey.orderReferrers
      ? parseOrderReferrers(rowsByKey.orderReferrers)
      : null;
    const campaigns = rowsByKey.campaigns ? parseCampaigns(rowsByKey.campaigns, limit) : null;
    const byYear = rowsByKey.trafficMonthly ? parseTrafficMonthly(rowsByKey.trafficMonthly) : null;
    const landing = rowsByKey.landing ? parseLandingPages(rowsByKey.landing) : null;

    // Monthly discount rows extend the discounts section; the voucher report is
    // derived from the SAME two discount pulls (range totals + raw monthly rows for
    // the active-month date labels) — no extra queries.
    const discountMonthly = rowsByKey.discountMonthly
      ? parseDiscountMonthly(rowsByKey.discountMonthly)
      : null;

    // The merchant's ACTUAL configured terms for the codes in this report, so the
    // Promotions panels can state what a code gives the customer without a hand-written
    // table or a guess parsed from the code's name. Best-effort and unbatched with the
    // ShopifyQL pool (it's the Admin API, not analytics): a token without read_discounts
    // just leaves terms null and the UI shows "—".
    const parsedCodes = rowsByKey.discountCodes ? parseDiscountCodes(rowsByKey.discountCodes) : null;
    let discountTerms = null;
    if (parsedCodes?.codes?.length) {
      try {
        const nodes = await fetchDiscountTerms(cfg, parsedCodes.codes.map((c) => c.code));
        discountTerms = parseDiscountTerms(nodes);
        metaSections.discountTerms = { ok: true, resolved: Object.keys(discountTerms).length };
      } catch (e) {
        metaSections.discountTerms = failInfo(e);
      }
    }
    const voucherReport = rowsByKey.discountCodes
      ? buildVoucherReport(rowsByKey.discountCodes, rowsByKey.discountMonthly)
      : null;

    const sections = {
      // Composite sections are null only when ALL their sources failed.
      bestSellers: bySku || byTitle ? { bySku, byTitle, images } : null,
      discounts: rowsByKey.discountCodes || discountMonthly
        ? {
            ...(parsedCodes || { codes: null, others: null, noCode: null }),
            monthly: discountMonthly,
            // { CODE: {kind, amount, percentage, minSubtotal, usageLimit, …} }
            terms: discountTerms,
          }
        : null,
      categories,
      traffic: referrers || orderReferrers || campaigns || byYear || landing
        ? { referrers, orderReferrers, campaigns, byYear, landing }
        : null,
      funnel: rowsByKey.funnel ? parseFunnel(rowsByKey.funnel) : null,
      voucherReport,
      targets,
    };

    const live = results.some((r) => r.status === "fulfilled");
    const meta = {
      live,
      brand,
      asOf: new Date().toISOString(),
      range: { start, end },
      apiVersion: cfg.version,
      limit,
      // Which of the ten queries this response actually covers — so a caller merging
      // two partitioned payloads can tell "not asked for" from "failed".
      queries: queries.map((s) => s.key),
      sections: metaSections,
    };

    if (!live) {
      const firstFail = Object.values(metaSections).find((s) => s.ok === false && s.reason !== "no-targets");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        sections,
        meta: { ...meta, reason: firstFail?.reason || "no-data", message: firstFail?.message },
      });
    }

    // Only a fully successful payload is edge-cached, and briefly (5 min): caching a
    // partially throttled one would pin its missing sections on every visitor until
    // the cache expired.
    const allOk =
      results.every((r) => r.status === "fulfilled") &&
      metaSections.productImages?.ok !== false;
    res.setHeader(
      "Cache-Control",
      allOk ? "public, s-maxage=300, stale-while-revalidate=600" : "no-store",
    );
    return res.status(200).json({ sections, meta });
  } catch (e) {
    const reason = e instanceof ShopifyError ? e.reason : "error";
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      sections: emptySections,
      meta: { live: false, brand, reason, message: String(e?.message || e), sections: metaSections },
    });
  }
}
