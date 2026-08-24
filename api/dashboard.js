// api/dashboard.js
// Vercel serverless endpoint. Pulls live iORA SG orders from Shopify for a date
// range, aggregates them into the dashboard's metric shape, and returns JSON the
// front-end overlays onto its baseline. Never exposes the token to the browser.
//
// Query params (optional):
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD   — defaults to (current year)-01-01 .. today
//   ?only=fulfillment                  — serve ONLY the pickup-vs-delivery split, from
//                                        its own cheap orders pull (see below)
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
  resolveConfig,
  envNames,
  fetchOrders,
  fetchFulfillmentOrders,
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
  todayInTZ,
  ORDER_METRICS,
} from "../lib/aggregate.js";
import { normalizeBrand } from "../lib/env-keys.js";
import { settledPool } from "../lib/http.js";
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

// Wall-clock bound on the `only=fulfillment` orders pull, well inside the endpoint's
// 60s ceiling so the function answers with a reason instead of being killed. On expiry
// the section FAILS — a partial pull is a chronological prefix, and a percentage
// computed from one is biased (see fetchFulfillmentOrders).
const FULFILLMENT_BUDGET_MS = 45000;

// Per-section failure record for meta.sections — same convention as api/insights.js,
// so the front-end reads one shape wherever a section is reported on.
const failInfo = (e) => ({
  ok: false,
  reason: e instanceof ShopifyError ? e.reason : "error",
  message: String(e?.message || e).slice(0, 400),
});

// `only=fulfillment` — the pickup-vs-delivery split on its own, from the cheap
// four-scalar orders pull. It exists because the split used to ride the FULL orders
// pull below (45+ sequential pages of line-item payload, then the compareAt lookup),
// which put it right on the 60s function ceiling: slow on a good day, and gone
// entirely on a bad one, even though the split needs none of that data. A separate
// request gets its own budget, and — because it either covers the whole window or
// fails — a success is safe to edge-cache.
async function fulfillmentOnly(res, cfg, brand, start, end) {
  // shippingAddress.zip is protected customer data on some tokens. A denial costs only
  // the delivery-district breakdown — the split itself comes off shippingLine — so
  // retry once without the address rather than lose the section.
  let includeShipAddress = true;
  let pull;
  try {
    const opts = { start, end, timeBudgetMs: FULFILLMENT_BUDGET_MS };
    try {
      pull = await fetchFulfillmentOrders(cfg, { ...opts, includeShipAddress });
    } catch (e) {
      if (!(e instanceof ShopifyError) || e.reason !== "scope") throw e;
      includeShipAddress = false;
      pull = await fetchFulfillmentOrders(cfg, { ...opts, includeShipAddress });
    }
  } catch (e) {
    const info = failInfo(e);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      sections: { fulfillment: null },
      meta: {
        live: false,
        brand,
        only: "fulfillment",
        range: { start, end },
        reason: info.reason,
        message: info.message,
        sections: { fulfillment: info },
      },
    });
  }

  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  return res.status(200).json({
    sections: { fulfillment: buildFulfillmentSection(pull.orders) },
    meta: {
      live: true,
      brand,
      only: "fulfillment",
      asOf: new Date().toISOString(),
      range: { start, end },
      orderCount: pull.orders.length,
      pages: pull.pages,
      // `truncated` is always false here by construction — an incomplete pull throws
      // rather than being served. Kept in the shape so readers see one convention.
      sections: { fulfillment: { ok: true, regions: includeShipAddress, truncated: false } },
    },
  });
}

export default async function handler(req, res) {
  const today = todayInTZ(SHOP_TZ);
  const q = req.query || {};
  const brand = normalizeBrand(q.brand);
  // Resolves the store's domain and mints a short-lived access token from its permanent
  // CLIENT_/SECRET_ pair (api/_token.js).
  const cfg = await resolveConfig(process.env, brand);

  // A brand with no token/domain configured isn't an error — it just isn't wired up yet.
  // Report it plainly (200 + reason) so the front-end skips that store quietly, leaving
  // its figures blank, instead of showing a failure. Distinct from a real credential
  // problem, which throws below and IS surfaced as a warning — as is a token that could
  // not be minted (cfg.tokenError), which is a live credentials fault, not a gap.
  if (!cfg.token || !cfg.domain || cfg.domain === "your-store.myshopify.com") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      SG: {},
      meta: {
        live: false,
        brand,
        reason: cfg.tokenError ? cfg.tokenError.reason : "not-configured",
        message: cfg.tokenError
          ? String(cfg.tokenError.message).slice(0, 400)
          : `No Shopify credentials configured for brand "${brand}". Set ${envNames(brand).domain}, ` +
            `${envNames(brand).client} and ${envNames(brand).secret} in the Vercel project's ` +
            `Environment Variables.`,
      },
    });
  }

  // Resolve + sanitize the requested window. Default: this calendar year to date.
  let start = isDate(q.start) ? q.start : `${today.slice(0, 4)}-01-01`;
  let end = isDate(q.end) ? q.end : today;
  if (start > end) [start, end] = [end, start]; // tolerate swapped inputs

  if (String(q.only || "") === "fulfillment") {
    return fulfillmentOnly(res, cfg, brand, start, end);
  }

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
    // customer-data approval, retry without it so the other metrics still load. The
    // shipping address used to need a fallback of its own here; it moved out with the
    // fulfillment section, which now has its own pull and its own ladder.
    let includeCustomer = true;
    let result = { orders: [], truncated: false };
    if (!light) {
      try {
        result = await fetchOrders(cfg, { start, end, includeCustomer });
      } catch (e) {
        if (e instanceof ShopifyError && e.reason === "scope") {
          includeCustomer = false;
          result = await fetchOrders(cfg, { start, end, includeCustomer });
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

    // Overlay the exact Analytics figures from ShopifyQL where available. Independent
    // best-effort calls: if one is unavailable (Admin API < 2025-10, or a token without
    // reports access) we keep the Orders-based numbers and the front-end shows dashes.
    //
    // The three run through a width-2 pool rather than one after another — they share no
    // data, so serialising them just added two round trips to every dashboard load. Width
    // 2 (not 3) keeps this inside the same cost-throttle headroom api/insights.js uses,
    // since the front-end fires both endpoints at once.
    let salesSource = "reconstructed";
    let sessionsLive = false;
    let shopifyqlError = null;
    let shopifyqlMessage = null;

    const [salesRes, sessRes, fulfilRes] = await settledPool(
      [
        () => shopifyQL(cfg, buildSalesQL(start, end)),
        () => shopifyQL(cfg, buildSessionsQL(start, end)),
        () => shopifyQL(cfg, buildFulfillmentsQL(start, end)),
      ],
      2,
    );
    // Failures are folded in query order, so `shopifyqlError` still reports the sales
    // dataset's reason in preference to the other two.
    const noteFail = (e) => {
      if (!shopifyqlError) shopifyqlError = e instanceof ShopifyError ? e.reason : "error";
    };

    if (salesRes.status === "fulfilled") {
      const sales = bucketSales(salesRes.value.rows, years);
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
    } else {
      noteFail(salesRes.reason);
      shopifyqlMessage = String(salesRes.reason?.message || salesRes.reason).slice(0, 400);
    }

    if (sessRes.status === "fulfilled") {
      const sess = bucketSessions(sessRes.value.rows, years);
      metrics.ses = sess.ses;
      metrics.conversion = sess.conversion;
      sessionsLive = true;
    } else {
      noteFail(sessRes.reason);
    }

    // Orders FULFILLED (fulfillments dataset) — shown alongside orders placed. Best-effort:
    // if unavailable, `ordf` stays null and the front-end hides that card.
    if (fulfilRes.status === "fulfilled") {
      metrics.ordf = bucketFulfillments(fulfilRes.value.rows, years).ordf;
    } else {
      noteFail(fulfilRes.reason);
    }

    // Order-derived insight sections — FULL mode only (light mode never pages orders,
    // so it cannot serve them and its response shape stays exactly as before), computed
    // from the orders array already pulled above rather than a second pull. Best-effort:
    // a failure nulls the section and records why in meta.sections.<key>, never the
    // whole payload. Runs AFTER the ShopifyQL calls so the compareAt lookup doesn't
    // compete with them for cost budget. The fulfillment split used to live here too;
    // it needs none of this data, so it moved to `only=fulfillment` above.
    let sections = null;
    const sectionsMeta = {};
    if (!light) {
      sections = { saleMix: null };
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
              `${envNames(brand).domain} / ${envNames(brand).client} / ${envNames(brand).secret} ` +
              "are not set in the project's Environment Variables.",
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
