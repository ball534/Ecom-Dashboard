// api/insights.js
// Vercel serverless endpoint behind the dashboard's "insight" sections: best sellers
// (by SKU + product title), discount-code performance, category mix (SKU-prefix map),
// traffic attribution, and manually-maintained sales targets. Companion to
// /api/dashboard (which serves the monthly metric series) — this one serves top-N
// tables for a window, in ONE round trip, so the front-end fetches both in parallel.
//
// Query params (optional):
//   ?brand=SG&start=YYYY-MM-DD&end=YYYY-MM-DD&limit=10   — limit clamped 1..50
//
// Every response is HTTP 200. Sections are BEST-EFFORT and independent: the six
// ShopifyQL calls run in parallel (Promise.allSettled) and a failed call yields
// sections.<x> = null plus a reason in meta.sections.<key> — the payload never 500s.
// Targets come from lib/targets.js (local data, no Shopify) and are served even when
// the brand has no Shopify credentials.

import { getConfig, envNames, shopifyQL, fetchProductImagesByTitle, ShopifyError } from "./_shopify.js";
import {
  INSIGHT_QUERIES,
  SKU_PULL_LIMIT,
  parseTopSkus,
  parseTopTitles,
  parseDiscountCodes,
  parseReferrers,
  parseOrderReferrers,
  parseCampaigns,
  buildCategoryMix,
} from "../lib/insights.js";
import { CATEGORY_MAP } from "../lib/category-map.js";
import { TARGETS, getTargets } from "../lib/targets.js";

const SHOP_TZ = "Asia/Singapore";
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Same live-store set + fallback as api/dashboard.js.
const LIVE_BRANDS = new Set([
  "SG", "MY", "TRTSG", "TRTMY", "SANSSG", "SANSMY", "MONOSG", "MONOMY",
]);
function resolveBrand(q) {
  const b = String(q.brand || "SG").toUpperCase();
  return LIVE_BRANDS.has(b) ? b : "SG";
}

function todayInTZ(tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const failInfo = (e) => ({
  ok: false,
  reason: e instanceof ShopifyError ? e.reason : "error",
  message: String(e?.message || e).slice(0, 400),
});

// Run thunks with limited concurrency, returning Promise.allSettled-shaped results.
// Firing all six insight queries at once can trip Shopify's cost throttle — and take
// down /api/dashboard's sales query (fetched by the front-end at the same moment),
// which is what blanks Sales Revenue / Order Count to dashes.
async function settledPool(thunks, width) {
  const results = new Array(thunks.length);
  let next = 0;
  async function worker() {
    while (next < thunks.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await thunks[i]() };
      } catch (e) {
        results[i] = { status: "rejected", reason: e };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, thunks.length) }, worker));
  return results;
}

export default async function handler(req, res) {
  const today = todayInTZ(SHOP_TZ);
  const q = req.query || {};
  const brand = resolveBrand(q);
  const cfg = getConfig(process.env, brand);

  let start = isDate(q.start) ? q.start : `${today.slice(0, 4)}-01-01`;
  let end = isDate(q.end) ? q.end : today;
  if (start > end) [start, end] = [end, start];
  const limit = Math.min(50, Math.max(1, Number(q.limit) || 10));

  const years = [];
  for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) years.push(y);

  // Targets are local data — resolved regardless of Shopify credentials. A malformed
  // hand-edit of lib/targets.js degrades to a per-section error, never a 500.
  let targets = null;
  const metaSections = {};
  try {
    targets = getTargets(TARGETS, brand, years);
    metaSections.targets = targets ? { ok: true } : { ok: false, reason: "no-targets" };
  } catch (e) {
    metaSections.targets = { ok: false, reason: "error", message: String(e?.message || e).slice(0, 400) };
  }

  const emptySections = {
    bestSellers: null,
    discounts: null,
    categories: null,
    traffic: null,
    targets,
  };

  // A brand with no token/domain isn't an error — mirror api/dashboard.js exactly.
  if (!cfg.token || !cfg.domain || cfg.domain === "your-store.myshopify.com") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      sections: emptySections,
      meta: {
        live: false,
        brand,
        reason: "not-configured",
        message:
          `No Shopify credentials configured for brand "${brand}". Set ${envNames(brand).token} ` +
          `and ${envNames(brand).domain} in the Vercel project's Environment Variables.`,
        sections: metaSections,
      },
    });
  }

  try {
    const results = await settledPool(
      INSIGHT_QUERIES.map((spec) => () => shopifyQL(cfg, spec.build(start, end, limit))),
      2,
    );
    const rowsByKey = {};
    INSIGHT_QUERIES.forEach((spec, i) => {
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

    let categories = null;
    if (skuRows) {
      categories = buildCategoryMix(skuRows, CATEGORY_MAP);
      categories.truncated = skuRows.length >= SKU_PULL_LIMIT;
    }

    const referrers = rowsByKey.referrers ? parseReferrers(rowsByKey.referrers) : null;
    const orderReferrers = rowsByKey.orderReferrers
      ? parseOrderReferrers(rowsByKey.orderReferrers)
      : null;
    const campaigns = rowsByKey.campaigns ? parseCampaigns(rowsByKey.campaigns, limit) : null;

    const sections = {
      // Composite sections are null only when ALL their sources failed.
      bestSellers: bySku || byTitle ? { bySku, byTitle, images } : null,
      discounts: rowsByKey.discountCodes ? parseDiscountCodes(rowsByKey.discountCodes) : null,
      categories,
      traffic: referrers || orderReferrers || campaigns
        ? { referrers, orderReferrers, campaigns }
        : null,
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
