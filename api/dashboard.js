// api/dashboard.js
// Vercel serverless endpoint. Pulls live iORA SG orders from Shopify for a date
// range, aggregates them into the dashboard's metric shape, and returns JSON the
// front-end overlays onto its baseline. Never exposes the token to the browser.
//
// Query params (optional):
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD   — defaults to (current year)-01-01 .. today
//
// Success  -> { SG: {rev,ord,uni,dis,vou,cust,ret,ses,conversion}, meta:{ live:true, ... } }
// Failure  -> { SG: {}, meta:{ live:false, reason } }                          (not cached)
//
// Data sources (both via the same Admin API + token — no Claude/MCP at runtime):
//   • rev, dis, ord, uni, cust, ret, ses, conversion — ShopifyQL (`shopifyqlQuery`): the
//     exact figures from the admin Analytics engine. If ShopifyQL is unavailable (older API
//     version / missing reports access) rev/dis/ord/uni/cust/ret fall back to the Orders
//     reconstruction and ses/conversion stay absent (front-end shows dashes).
//   • vou                              — Orders API (gift-card/store-credit orders; ShopifyQL
//     has no clean column for this).

import {
  getConfig,
  envNames,
  fetchOrders,
  fetchVariantCompareAt,
  shopifyQL,
  ShopifyError,
} from "./_shopify.js";
import {
  bucketOrders,
  buildFulfillmentSection,
  buildSaleMixSection,
  monthsWithData,
  emptyYear,
  ORDER_METRICS,
} from "../lib/aggregate.js";
import {
  buildSalesQL,
  buildSessionsQL,
  buildFulfillmentsQL,
  bucketSales,
  bucketSessions,
  bucketFulfillments,
} from "../lib/shopifyql.js";

// An all-null metrics skeleton (no Orders API pull). Used by `light` mode, where the
// front-end wants the exact ShopifyQL Analytics figures across a multi-year range
// without paging tens of thousands of orders for the `vou` reconstruction.
function emptyMetrics(years) {
  const out = {};
  for (const m of [...ORDER_METRICS, "ordf"]) {
    out[m] = {};
    for (const y of years) out[m][y] = emptyYear();
  }
  return out;
}

const SHOP_TZ = "Asia/Singapore";
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Per-section failure record for meta.sections — same convention as api/insights.js,
// so the front-end reads one shape wherever a section is reported on.
const failInfo = (e) => ({
  ok: false,
  reason: e instanceof ShopifyError ? e.reason : "error",
  message: String(e?.message || e).slice(0, 400),
});

// Individual stores the dashboard can request live (one Shopify store each). The
// front-end's roll-up brands (SGALL/MYALL/GROUP) are computed client-side from these,
// so they never hit this endpoint directly. Unknown/absent brand -> SG.
const LIVE_BRANDS = new Set([
  "SG", "MY", "TRTSG", "TRTMY", "SANSSG", "SANSMY", "MONOSG", "MONOMY",
]);
function resolveBrand(q) {
  const b = String(q.brand || "SG").toUpperCase();
  return LIVE_BRANDS.has(b) ? b : "SG";
}

// "Today" as YYYY-MM-DD in the shop's timezone (en-CA formats as ISO date).
function todayInTZ(tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export default async function handler(req, res) {
  const today = todayInTZ(SHOP_TZ);
  const q = req.query || {};
  const brand = resolveBrand(q);
  const cfg = getConfig(process.env, brand);

  // A brand with no token/domain configured isn't an error — it just isn't wired up yet.
  // Report it plainly (200 + reason) so the front-end skips that store quietly, leaving
  // its figures blank, instead of showing a failure. Distinct from a real credential
  // problem, which throws below and IS surfaced as a warning.
  if (!cfg.token || !cfg.domain || cfg.domain === "your-store.myshopify.com") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      SG: {},
      meta: {
        live: false,
        brand,
        reason: "not-configured",
        message:
          `No Shopify credentials configured for brand "${brand}". Set ${envNames(brand).token} ` +
          `and ${envNames(brand).domain} in the Vercel project's Environment Variables.`,
      },
    });
  }

  // Resolve + sanitize the requested window. Default: this calendar year to date.
  let start = isDate(q.start) ? q.start : `${today.slice(0, 4)}-01-01`;
  let end = isDate(q.end) ? q.end : today;
  if (start > end) [start, end] = [end, start]; // tolerate swapped inputs

  // `light=1` skips the Orders API pagination entirely and returns ONLY the ShopifyQL
  // Analytics figures. The dashboard uses it to load full multi-year history fast (one
  // round trip per dataset) for the year-on-year chart, without risking a cold-start
  // timeout while paging orders. `vou` (gift-card/store-credit orders) is omitted in
  // this mode since it has no ShopifyQL column.
  const light = q.light === "1" || q.light === "true";

  const years = [];
  for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) years.push(y);

  try {
    // Try with customer data (new vs returning). If the app lacks protected-
    // customer-data approval, retry without it so the other metrics still load.
    // The shipping address (delivery-region zips) is protected the same way, so it
    // gets a fallback of its own. Order matters: the address field is approved
    // separately from (and less commonly than) the customer block, so drop the
    // ADDRESS first — a token approved for customer data but not addresses keeps its
    // new-vs-returning split and only loses delivery regions. Ladder:
    //   1. customer + address  →  2. customer only  →  3. neither.
    let includeCustomer = true;
    let includeShipAddress = true;
    let result = { orders: [], truncated: false };
    if (!light) {
      try {
        result = await fetchOrders(cfg, { start, end, includeCustomer, includeShipAddress });
      } catch (e) {
        if (e instanceof ShopifyError && e.reason === "scope") {
          includeShipAddress = false;
          try {
            result = await fetchOrders(cfg, { start, end, includeCustomer, includeShipAddress });
          } catch (e2) {
            if (e2 instanceof ShopifyError && e2.reason === "scope") {
              includeCustomer = false;
              result = await fetchOrders(cfg, { start, end, includeCustomer, includeShipAddress });
            } else {
              throw e2;
            }
          }
        } else {
          throw e;
        }
      }
    }

    const metrics = light
      ? emptyMetrics(years)
      : Object.assign(bucketOrders(result.orders, { years, timeZone: SHOP_TZ }), {
          ordf: Object.fromEntries(years.map((y) => [y, emptyYear()])),
        });

    // Overlay the exact Analytics figures from ShopifyQL where available. These are
    // independent best-effort calls: if either is unavailable (e.g. an Admin API
    // version < 2025-10, or a token without reports access) we keep the Orders-based
    // numbers and the front-end simply shows dashes for Sessions/Conversion.
    let salesSource = "reconstructed";
    let sessionsLive = false;
    let shopifyqlError = null;
    let shopifyqlMessage = null;

    try {
      const { rows } = await shopifyQL(cfg, buildSalesQL(start, end));
      const sales = bucketSales(rows, years);
      // Authoritative — replace the Orders-reconstructed metrics outright. These match the
      // admin Analytics page exactly (no cancelled-order or first-time/returning drift).
      for (const y of years) {
        metrics.rev[y] = sales.rev[y];
        metrics.dis[y] = sales.dis[y];
        metrics.ord[y] = sales.ord[y];
        metrics.uni[y] = sales.uni[y];
        metrics.cust[y] = sales.cust[y];
        metrics.ret[y] = sales.ret[y];
      }
      salesSource = "shopifyql";
    } catch (e) {
      shopifyqlError = e instanceof ShopifyError ? e.reason : "error";
      shopifyqlMessage = String(e?.message || e).slice(0, 400);
    }

    try {
      const { rows } = await shopifyQL(cfg, buildSessionsQL(start, end));
      const sess = bucketSessions(rows, years);
      metrics.ses = sess.ses;
      metrics.conversion = sess.conversion;
      sessionsLive = true;
    } catch (e) {
      if (!shopifyqlError) shopifyqlError = e instanceof ShopifyError ? e.reason : "error";
    }

    // Orders FULFILLED (fulfillments dataset) — shown alongside orders placed. Best-effort:
    // if unavailable, `ordf` stays null and the front-end hides that card.
    try {
      const { rows } = await shopifyQL(cfg, buildFulfillmentsQL(start, end));
      metrics.ordf = bucketFulfillments(rows, years).ordf;
    } catch (e) {
      if (!shopifyqlError) shopifyqlError = e instanceof ShopifyError ? e.reason : "error";
    }

    // Order-derived insight sections — FULL mode only (light mode never pages orders,
    // so it cannot serve them and its response shape stays exactly as before). Both
    // are computed from the SAME orders array already pulled above — no second pull.
    // Each section is individually best-effort: a failure nulls that section and
    // records why in meta.sections.<key>, never the whole payload. Runs AFTER the
    // ShopifyQL calls so the compareAt lookup doesn't compete with them for cost budget.
    let sections = null;
    const sectionsMeta = {};
    if (!light) {
      sections = { fulfillment: null, saleMix: null };
      // Pickup vs delivery split (+ pickup points, delivery districts). Pure local math.
      try {
        sections.fulfillment = buildFulfillmentSection(result.orders);
        sectionsMeta.fulfillment = { ok: true, regions: includeShipAddress, truncated: result.truncated };
      } catch (e) {
        sectionsMeta.fulfillment = failInfo(e);
      }
      // Sale-vs-full-price mix: one batched compareAtPrice lookup over the DISTINCT
      // variant ids actually seen in the pulled lines, then pure local classification.
      // If the lookup fails, the section is null — classifying every line "full"
      // without the catalogue join would be a made-up split, not a degraded one.
      try {
        const variantIds = [
          ...new Set(
            result.orders.flatMap((o) => (o.lines || []).map((l) => l.variantId).filter(Boolean)),
          ),
        ];
        // 20s budget: keeps a huge catalogue's chunked lookup from pushing the whole
        // invocation past Vercel's 60s ceiling — the section fails cleanly instead.
        const compareAtByVariant = await fetchVariantCompareAt(cfg, variantIds, {
          timeBudgetMs: 20000,
        });
        sections.saleMix = buildSaleMixSection(result.orders, compareAtByVariant, {
          timeZone: SHOP_TZ,
        });
        sectionsMeta.saleMix = { ok: true, variants: variantIds.length, truncated: result.truncated };
      } catch (e) {
        sectionsMeta.saleMix = failInfo(e);
      }
    }

    // Did we actually obtain any live figures? In `light` mode nothing pages the
    // Orders API, so the outer try can't throw even when the token/domain are missing
    // or ShopifyQL is denied — every metric would just stay null. Reporting live:true
    // in that case makes the front-end show a green "Connected" over a wall of dashes.
    // Only claim `live` when real data came back, so the UI shows the failure reason.
    const gotLiveData =
      salesSource === "shopifyql" || sessionsLive || (!light && result.orders.length > 0);
    if (!gotLiveData) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        SG: {},
        meta: {
          live: false,
          reason: shopifyqlError || "no-data",
          // The raw Shopify error + the API version actually in use, so the failure is
          // diagnosable from the browser (e.g. an old apiVersion means shopifyqlQuery
          // doesn't exist and every dataset comes back with a "graphql" error).
          message:
            shopifyqlMessage ||
            "The API responded but returned no live figures. On Vercel this usually means " +
              `${envNames(brand).token} / ${envNames(brand).domain} are not set in the ` +
              "project's Environment Variables.",
          apiVersion: cfg.version,
          salesSource,
          sessionsLive,
        },
      });
    }

    // Only a COMPLETE payload is edge-cached, and briefly (5 min) so the numbers stay
    // close to live. A partial one — e.g. the sales dataset throttled while sessions
    // landed — must never be cached: it would pin dashes on Sales Revenue / Order
    // Count for every visitor until the cache expired. Section failures only count
    // as partial when they're TRANSIENT (throttle/timeout — a refetch can fix them);
    // a deterministic failure (e.g. token lacks read_products, so saleMix can never
    // load) must not make the store's every response uncacheable forever.
    const transientSectionFail = Object.values(sectionsMeta).some(
      (s) => s.ok === false && (s.reason === "throttle" || s.reason === "timeout"),
    );
    const partial =
      salesSource !== "shopifyql" || !sessionsLive || transientSectionFail;
    res.setHeader(
      "Cache-Control",
      partial ? "no-store" : "public, s-maxage=300, stale-while-revalidate=600",
    );
    return res.status(200).json({
      SG: metrics,
      // Order-derived sections ride along in FULL mode only; light responses keep
      // their original shape (no `sections` key at all).
      ...(light ? {} : { sections }),
      meta: {
        live: true,
        partial,
        brand,
        asOf: new Date().toISOString(),
        range: { start, end },
        years,
        // months with data, keyed by year, so the front-end can label the window.
        monthsLive: Object.fromEntries(years.map((y) => [y, monthsWithData(metrics.ord[y])])),
        light,
        includeCustomer: light ? false : includeCustomer,
        includeShipAddress: light ? false : includeShipAddress,
        orderCount: result.orders.length,
        truncated: result.truncated,
        // Where the live sales/sessions numbers came from, so the header can be honest.
        salesSource, // "shopifyql" (exact, matches admin) | "reconstructed" (Orders fallback)
        sessionsLive, // true when Sessions/Conversion are live from ShopifyQL
        ...(light ? {} : { sections: sectionsMeta }),
        ...(shopifyqlError ? { shopifyqlError } : {}),
      },
    });
  } catch (e) {
    const reason = e instanceof ShopifyError ? e.reason : "error";
    // Do not cache failures — a transient error shouldn't be pinned at the edge.
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      SG: {},
      meta: { live: false, reason, message: String(e?.message || e) },
    });
  }
}
