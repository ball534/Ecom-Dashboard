// api/_shopify.js
// Minimal, dependency-free Shopify Admin GraphQL client. The leading underscore
// keeps Vercel from exposing this as an HTTP route. Used by api/dashboard.js and
// scripts/verify-token.js.

import { normalizeOrder } from "../lib/aggregate.js";
import { ShopifyError } from "./_error.js";
import { getAccessToken, hasAppCredentials } from "./_token.js";

// 2025-10 is the earliest Admin API version that exposes `shopifyqlQuery` (ShopifyQL).
// Older versions (<=2025-07) lack the field; the dashboard then falls back to the
// Orders-based reconstruction for sales (Sessions/Conversion show dashes).
const DEFAULT_API_VERSION = "2025-10";

// Re-exported so every caller keeps importing the error type from this module.
export { ShopifyError };

// Multi-store: each brand button on the dashboard is backed by its own Shopify store, so
// it needs its own Admin API token + permanent domain. Each store is one pair of env vars
// (see .env.example):
//   TOKEN_<STORE>   (e.g. TOKEN_IORASG, TOKEN_TRTMY)
//   DOMAIN_<STORE>  (e.g. DOMAIN_IORASG = iora-online.myshopify.com)
// The store suffix differs from the dashboard's internal brand key for the two iORA
// stores: brand SG -> TOKEN_IORASG, brand MY -> TOKEN_IORAMY. Everything else matches.
const ENV_SUFFIX = { SG: "IORASG", MY: "IORAMY" };
export const envSuffix = (brand) => {
  const B = String(brand || "SG").toUpperCase();
  return ENV_SUFFIX[B] || B;
};
// Names for this store's pair, used in "not configured" messages so they point at the
// exact variable to set.
export const envNames = (brand) => {
  const s = envSuffix(brand);
  return { token: `TOKEN_${s}`, domain: `DOMAIN_${s}` };
};

// Shopify's two credentials have unmistakable, non-overlapping shapes: an Admin API
// access token is `shp<xx>_…`, a store domain is `<handle>.myshopify.com`. So a pair
// that has been entered the wrong way round — the domain pasted into TOKEN_<STORE> and
// the token into DOMAIN_<STORE>, an easy slip when the vars sit next to each other —
// can be recognised with certainty. Worth recognising, because otherwise the token is
// used as a hostname: DNS can't resolve it, fetch throws, and the store reports the
// generic reason "http" ("Network error reaching Shopify"), which points at the network
// rather than at the two variables that are actually at fault.
const looksLikeToken = (v) => /^shp[a-z]{2}_/i.test(v);
const looksLikeDomain = (v) => /\.myshopify\.com$/i.test(v);
// Warn at most once per store per process, so a per-request call site doesn't flood logs.
const swapWarned = new Set();

// Read + sanitize config from the environment, for a given brand/store.
//
// The TOKEN_/DOMAIN_ pair above is the canonical naming. The older SHOPIFY_-prefixed
// names are still accepted as a fallback so an existing deployment (whose Vercel env
// vars predate the rename) keeps working untouched. API version is shared by every
// store via SHOPIFY_API_VERSION, unless one overrides it with SHOPIFY_API_VERSION_<KEY>.
export function getConfig(env = process.env, brand = "SG") {
  const strip = (s) => (s || "").trim().replace(/^['"]|['"]$/g, "");
  const B = String(brand || "SG").toUpperCase();
  const S = envSuffix(B);

  // Canonical: TOKEN_<STORE> / DOMAIN_<STORE>.
  let token = strip(env["TOKEN_" + S]);
  let domain = strip(env["DOMAIN_" + S]);

  // Legacy fallbacks (unsuffixed for SG, SHOPIFY_*_<BRAND> for the rest).
  if (!token) {
    token = B === "SG"
      ? strip(env.SHOPIFY_TOKEN) || strip(env.SHOPIFY_KEY)
      : strip(env["SHOPIFY_TOKEN_" + B]);
  }
  if (!domain) {
    domain = B === "SG"
      ? strip(env.SHOPIFY_STORE_DOMAIN)
      : strip(env["SHOPIFY_DOMAIN_" + B]) || strip(env["SHOPIFY_STORE_DOMAIN_" + B]);
  }
  // <STORE>_DOMAIN is the spelling oauth/main.py's .env used, alongside <STORE>_CLIENT /
  // <STORE>_SECRET. Accepting it means that block of credentials can be pasted into
  // Vercel as-is (see api/_token.js).
  if (!domain) domain = strip(env[S + "_DOMAIN"]);

  // Reduce a domain to a bare host first, so a pasted "https://<handle>.myshopify.com/admin"
  // is still recognised as a domain whichever variable it landed in.
  const bareHost = (v) => v.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  domain = bareHost(domain);
  if (looksLikeDomain(bareHost(token)) && looksLikeToken(domain)) {
    [token, domain] = [domain, bareHost(token)];
    if (!swapWarned.has(S)) {
      swapWarned.add(S);
      console.warn(
        `[shopify] TOKEN_${S} holds a store domain and DOMAIN_${S} holds an access token — ` +
          `the pair is the wrong way round. Reading them swapped so live data still loads; ` +
          `transpose the two values to clear this warning.`,
      );
    }
  }

  const version =
    strip(env["SHOPIFY_API_VERSION_" + B]) || strip(env.SHOPIFY_API_VERSION) || DEFAULT_API_VERSION;
  return { token, domain, version, brand: B };
}

// getConfig + "if this store has no permanent token, mint a short-lived one now".
//
// This is what every request path should use. It is what removes the 24-hour chore: only
// iORA SG needs a TOKEN_ variable, and every other store is authenticated from its
// permanent CLIENT_/SECRET_ pair via the client_credentials grant (api/_token.js).
//
// It never throws. A minting failure comes back as `cfg.tokenError` with `cfg.token`
// empty, so the endpoints report it the same way they already report a store that isn't
// wired up — a diagnosable 200, not a 500.
//
// The returned cfg also carries `refresh()`, used by shopifyGraphQL to re-mint once if a
// token is rejected mid-flight (see below).
export async function resolveConfig(env = process.env, brand = "SG") {
  const cfg = getConfig(env, brand);
  const S = envSuffix(brand);

  // A permanent token (iORA SG) always wins, and with no domain there is nothing to
  // authenticate against — both fall through to the caller's "not configured" handling.
  if (cfg.token || !cfg.domain) return cfg;
  if (!hasAppCredentials(env, S)) return cfg;

  cfg.minted = true;
  cfg.refresh = async () => {
    cfg.token = await getAccessToken(env, S, cfg.domain, { force: true, stale: cfg.token });
    return cfg.token;
  };
  try {
    cfg.token = await getAccessToken(env, S, cfg.domain);
  } catch (e) {
    cfg.token = "";
    cfg.tokenError = e;
  }
  return cfg;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bursts of concurrent calls (several dashboard windows + the insights fan-out)
// can hit Shopify's GraphQL cost throttle. The bucket restores within a second
// or two, so a short backoff-and-retry absorbs it instead of failing the section.
const THROTTLE_RETRIES = 2;

export async function shopifyGraphQL(cfg, query, variables = {}, _attempt = 0) {
  if (!cfg.domain || cfg.domain === "your-store.myshopify.com") {
    throw new ShopifyError("no-domain", `${envNames(cfg.brand).domain} is not set`);
  }
  if (!cfg.token) {
    throw new ShopifyError("no-token", `${envNames(cfg.brand).token} is not set`);
  }

  const url = `https://${cfg.domain}/admin/api/${cfg.version}/graphql.json`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": cfg.token,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    throw new ShopifyError("http", `Network error reaching Shopify: ${e.message}`);
  }

  // A minted token can stop working before its nominal expiry — the app is reinstalled,
  // its credentials are rotated, or (a full year-scale pull runs for tens of seconds) it
  // simply lapses mid-request. Mint a replacement and retry the query once; `refresh()`
  // de-duplicates so parallel queries on the same cfg share one new token. 403 is left
  // alone deliberately: that is a missing scope, which a fresh token cannot fix.
  if (res.status === 401 && typeof cfg.refresh === "function" && !cfg.reauthTried) {
    cfg.reauthTried = true;
    try {
      await cfg.refresh();
      return shopifyGraphQL(cfg, query, variables, _attempt);
    } catch {
      // Fall through to the auth error below — re-minting failed too.
    }
  }
  if (res.status === 401 || res.status === 403) {
    throw new ShopifyError("auth", `Shopify rejected the token (HTTP ${res.status}). The token may be invalid or not a Shopify Admin token.`, res.status);
  }
  if (res.status === 429) {
    if (_attempt < THROTTLE_RETRIES) {
      await sleep(1200 * (_attempt + 1));
      return shopifyGraphQL(cfg, query, variables, _attempt + 1);
    }
    throw new ShopifyError("throttle", "Shopify rate limit hit (HTTP 429).", 429);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ShopifyError("http", `Shopify HTTP ${res.status}: ${body.slice(0, 300)}`, res.status);
  }

  const json = await res.json();
  if (json.errors) {
    const msg = JSON.stringify(json.errors);
    // Cost-throttling surfaces as a GraphQL error (code THROTTLED), not HTTP 429.
    if (/THROTTLED|rate limited/i.test(msg)) {
      if (_attempt < THROTTLE_RETRIES) {
        await sleep(1200 * (_attempt + 1));
        return shopifyGraphQL(cfg, query, variables, _attempt + 1);
      }
      throw new ShopifyError("throttle", msg);
    }
    // Distinguish "needs a scope / protected-data approval" from generic GraphQL errors.
    const reason = /access denied|not approved|read_all_orders|protected customer|requires merchant approval/i.test(msg)
      ? "scope"
      : "graphql";
    throw new ShopifyError(reason, msg);
  }
  return json.data;
}

// Lightweight connectivity + auth check. Returns { name, myshopifyDomain, ianaTimezone, currencyCode }.
export async function verifyToken(cfg) {
  const data = await shopifyGraphQL(
    cfg,
    `{ shop { name myshopifyDomain ianaTimezone currencyCode } }`,
  );
  return data.shop;
}

// Run a ShopifyQL query through the Admin API's `shopifyqlQuery` field — the same
// engine that powers the admin Analytics page. This gives the EXACT Gross Sales /
// Discounts / Orders figures (no per-line reconstruction) and the web-analytics
// metrics (Sessions, Conversion) that the Orders API cannot provide. Requires the
// read_reports / read_analytics scopes (and, for some datasets, a Shopify Plus shop).
//
// Returns { columns: [{name, dataType}], rows: [ {col: value, ...}, ... ] }.
// Rows come back as JSON objects keyed by column name. A ShopifyQL parse/permission
// problem surfaces as ShopifyError("scope", ...) so callers can fall back gracefully.
const SHOPIFYQL_QUERY = `
query ShopifyQL($q: String!) {
  shopifyqlQuery(query: $q) {
    parseErrors
    tableData {
      columns { name dataType }
      rows
    }
  }
}`;

export async function shopifyQL(cfg, ql) {
  const data = await shopifyGraphQL(cfg, SHOPIFYQL_QUERY, { q: ql });
  const resp = data?.shopifyqlQuery;
  // parseErrors is a list of strings; a non-empty list means the query was rejected
  // (bad column, no analytics access, etc.). Treat it as a scope/availability problem
  // so api/dashboard.js can fall back to the Orders reconstruction.
  const errs = Array.isArray(resp?.parseErrors) ? resp.parseErrors.filter(Boolean) : [];
  if (errs.length) {
    throw new ShopifyError("scope", `ShopifyQL parse error: ${errs.join("; ")}`);
  }
  const table = resp?.tableData;
  if (!table) {
    throw new ShopifyError("scope", "ShopifyQL returned no tableData (no analytics access for this token?)");
  }
  const columns = Array.isArray(table.columns) ? table.columns : [];
  const rows = Array.isArray(table.rows) ? table.rows : [];
  return { columns, rows };
}

// first:250 (the connection maximum). Measured live with the full field set below:
// requestedQueryCost 464, actualQueryCost 51 against a 20,000-point bucket and the
// 1,000-point single-query cap — big pages cost almost nothing extra, and a
// year-scale pull drops from ~94 round trips to ~38, which is what keeps the FULL
// /api/dashboard mode inside a serverless time limit. The per-line fields
// (originalTotal + taxLines + discountAllocations) reconstruct Shopify's
// tax-EXCLUDED Gross Sales and Discounts exactly as the Analytics report does.
//
// lineItems sku + variant.id feed the sale-vs-full-price classification (variant ids
// are joined against current compareAtPrice via fetchVariantCompareAt). The sold unit
// price is DERIVED as originalTotal/quantity rather than requesting
// originalUnitPriceSet — identical value, zero extra query cost (measured live:
// requestedQueryCost 380 per page against the 20,000-point bucket).
//
// The pickup-vs-delivery fields are deliberately NOT here. That split needs four
// scalars per order and no line items at all, so it is served by the far cheaper
// FULFILLMENT_ORDERS_QUERY below — it no longer waits on, or dies with, this
// heavyweight pull. See fetchFulfillmentOrders.
const ORDERS_QUERY = (includeCustomer) => `
query Orders($cursor: String, $q: String!) {
  orders(first: 250, after: $cursor, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        createdAt
        test
        cancelledAt
        taxesIncluded
        paymentGatewayNames
        lineItems(first: 100) {
          edges { node {
            quantity
            sku
            variant { id }
            originalTotalSet { shopMoney { amount } }
            taxLines { rate }
            discountAllocations { allocatedAmountSet { shopMoney { amount } } }
          } }
        }
        ${includeCustomer ? "customer { id numberOfOrders }" : ""}
      }
    }
  }
}`;

// Resolve featured-image URLs for a set of product titles (the best-sellers list).
// ShopifyQL's sales dataset returns only titles — no product IDs or images — so the
// dashboard used to rely on hand-maintained title→URL maps that go stale. This does
// the join server-side in ONE aliased GraphQL request. A `title:` search is a
// substring match, so results are re-checked for an exact (case-insensitive) title
// before an image is attached — a near-miss must not show the wrong product's photo.
// Returns { "<title>": "<url>", ... } (titles with no confident match are omitted).
export async function fetchProductImagesByTitle(cfg, titles) {
  const list = [...new Set((titles || []).filter(Boolean))].slice(0, 50);
  if (!list.length) return {};
  const vars = {};
  const parts = list.map((t, i) => {
    // JSON.stringify wraps the title in double quotes (a phrase match in Shopify's
    // search syntax) and escapes any quotes inside it.
    vars["q" + i] = "title:" + JSON.stringify(t);
    return `p${i}: products(first: 5, query: $q${i}) { edges { node { title featuredImage { url } } } }`;
  });
  const query =
    `query ProductImages(${list.map((_, i) => `$q${i}: String!`).join(", ")}) { ${parts.join(" ")} }`;
  const data = await shopifyGraphQL(cfg, query, vars);
  const norm = (s) => String(s || "").trim().toLowerCase();
  const out = {};
  list.forEach((t, i) => {
    const edges = data?.["p" + i]?.edges || [];
    const hit =
      edges.find((e) => norm(e?.node?.title) === norm(t)) ||
      (edges.length === 1 ? edges[0] : null);
    const url = hit?.node?.featuredImage?.url;
    // Originals can be multi-MB; Shopify's CDN resizes on the fly via ?width=.
    // 600px comfortably covers the gallery card at 2x density.
    if (url) out[t] = url + (url.includes("?") ? "&" : "?") + "width=600";
  });
  return out;
}

// Real, configured terms for a set of discount CODES — what the customer actually gets,
// straight from the discount the merchant set up in Shopify.
//
// The dashboard used to carry a hand-written table of code → "$12 off · min $80 · 1
// use/customer", plus a pile of guesswork that parsed the code name and reverse-engineered
// amounts from average discount per order. Both invent facts: a code whose terms changed
// in Shopify kept showing the old ones, and the inferred figures were never verified by
// anything. These are the merchant's own values.
//
// `codeDiscountNodeByCode` is an exact lookup, so the whole set resolves in ONE aliased
// request (same shape as fetchProductImagesByTitle). Requires `read_discounts`; a token
// without it raises ShopifyError("scope") and callers serve the section without terms
// rather than falling back to a guess.
const DISCOUNT_TERM_FIELDS = `
  __typename
  ... on DiscountCodeBasic {
    title status startsAt endsAt usageLimit appliesOncePerCustomer
    customerGets { value {
      __typename
      ... on DiscountAmount { amount { amount currencyCode } appliesOnEachItem }
      ... on DiscountPercentage { percentage }
    } }
    minimumRequirement {
      __typename
      ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } }
      ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
    }
  }
  ... on DiscountCodeFreeShipping {
    title status startsAt endsAt usageLimit appliesOncePerCustomer
    minimumRequirement {
      __typename
      ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } }
      ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
    }
  }
  ... on DiscountCodeBxgy {
    title status startsAt endsAt usageLimit appliesOncePerCustomer
    customerBuys { value {
      __typename
      ... on DiscountQuantity { quantity }
      ... on DiscountPurchaseAmount { amount }
    } }
    customerGets { value {
      __typename
      ... on DiscountOnQuantity { quantity { quantity } effect {
        __typename
        ... on DiscountAmount { amount { amount currencyCode } }
        ... on DiscountPercentage { percentage }
      } }
    } }
  }`;

// Returns { "<CODE>": <raw codeDiscount node>, ... } — codes Shopify doesn't know are
// simply absent (callers then show no terms rather than an invented mechanic).
export async function fetchDiscountTerms(cfg, codes) {
  const list = [...new Set((codes || []).filter(Boolean).map((c) => String(c)))].slice(0, 50);
  if (!list.length) return {};
  const vars = {};
  const parts = list.map((c, i) => {
    vars["c" + i] = c;
    return `d${i}: codeDiscountNodeByCode(code: $c${i}) { codeDiscount { ${DISCOUNT_TERM_FIELDS} } }`;
  });
  const query =
    `query DiscountTerms(${list.map((_, i) => `$c${i}: String!`).join(", ")}) { ${parts.join(" ")} }`;
  const data = await shopifyGraphQL(cfg, query, vars);
  const out = {};
  list.forEach((c, i) => {
    const node = data?.["d" + i]?.codeDiscount;
    if (node) out[c] = node;
  });
  return out;
}

// Page through all orders matching a created_at window, returning normalized records.
// `maxPages` is a safety cap (250 orders/page). For very large multi-year pulls,
// swap this for a Bulk Operation (see README) — the aggregation logic is unchanged.
// `includeCustomer` is a protected-data switch: api/dashboard.js drops it when Shopify
// denies the scope, so a token without protected-customer-data approval still gets
// everything the token CAN serve.
export async function fetchOrders(
  cfg,
  { start, end, includeCustomer = true, maxPages = 400 } = {},
) {
  const q = `created_at:>=${start} created_at:<=${end}`;
  const query = ORDERS_QUERY(includeCustomer);
  const orders = [];
  let cursor = null;
  let pages = 0;

  do {
    const data = await shopifyGraphQL(cfg, query, { cursor, q });
    const conn = data.orders;
    for (const e of conn.edges) {
      const o = normalizeOrder(e.node);
      // Exclude only TEST orders. Cancelled orders are KEPT: Shopify's items/quantity
      // report counts them, and revenue uses the current total which already nets any
      // refund on a cancelled order — so keeping them matches the admin reports.
      if (o.test) continue;
      orders.push(o);
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages += 1;
  } while (cursor && pages < maxPages);

  return { orders, truncated: Boolean(cursor), pages };
}

// The pickup-vs-delivery split reads FOUR scalars per order and nothing else:
//   • shippingLine.title   — the discriminator ("Pick Up @ <store> (<address>)").
//     fulfillmentOrders.deliveryMethod is access-denied on this token, so the title is
//     the only reliable signal.
//   • shippingAddress.zip  — delivery postal district (first 2 chars; the raw zip is
//     dropped inside normalizeOrder and never leaves the server). PROTECTED customer
//     data on some tokens, hence independently droppable via `includeShipAddress` —
//     a denial degrades to pickup-split-without-regions instead of failing the pull.
//   • cancelledAt          — cancelled orders are excluded from the split so it ties to
//     the ShopifyQL Orders KPI shown beside it.
//   • test                 — test orders are dropped entirely.
// No line items, no money, no customer block: a page here costs a fraction of an
// ORDERS_QUERY page, which is what lets the split load in its own fast request
// (/api/dashboard?only=fulfillment) rather than riding the heavyweight pull.
const FULFILLMENT_ORDERS_QUERY = (includeShipAddress = true) => `
query FulfillmentOrders($cursor: String, $q: String!) {
  orders(first: 250, after: $cursor, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        createdAt
        test
        cancelledAt
        shippingLine { title }
        ${includeShipAddress ? "shippingAddress { zip }" : ""}
      }
    }
  }
}`;

// Page a window for the pickup-vs-delivery split ONLY. Records come back through the
// same normalizeOrder as the full pull, so isPickup / pickupPoint / shipZipDistrict are
// derived by exactly one piece of code and the resulting split is identical whichever
// query fed it.
//
// Those records carry amount/units/discounts of 0 and no `lines` — the fields simply
// weren't requested. They must NEVER reach bucketOrders; buildFulfillmentSection is the
// only legitimate consumer.
//
// FAIL-CLEAN: an incomplete pull THROWS rather than returning what it has. Orders arrive
// in created_at order, so a partial pull is a chronological PREFIX of the window, not a
// sample of it — a pickup percentage computed from one would be biased by however the
// mix moves through the year, and would look entirely plausible on screen. A blank panel
// is the honest outcome. Same principle as lib/http.js's `deadline`.
export async function fetchFulfillmentOrders(
  cfg,
  { start, end, includeShipAddress = true, maxPages = 400, timeBudgetMs = 0 } = {},
) {
  const q = `created_at:>=${start} created_at:<=${end}`;
  const query = FULFILLMENT_ORDERS_QUERY(includeShipAddress);
  const startedAt = Date.now();
  const orders = [];
  let cursor = null;
  let pages = 0;

  do {
    // Checked BEFORE each page so the budget is a bound on the whole pull, leaving the
    // caller's serverless invocation room to answer instead of being killed mid-flight.
    if (timeBudgetMs > 0 && Date.now() - startedAt > timeBudgetMs) {
      throw new ShopifyError(
        "timeout",
        `fulfillment order pull exceeded its ${timeBudgetMs}ms budget after ${pages} pages`,
      );
    }
    const data = await shopifyGraphQL(cfg, query, { cursor, q });
    const conn = data.orders;
    for (const e of conn.edges) {
      const o = normalizeOrder(e.node);
      if (o.test) continue;
      orders.push(o);
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages += 1;
  } while (cursor && pages < maxPages);

  // Hitting the page cap is NOT transient — a refetch reproduces it exactly — so it
  // carries its own reason and callers must not schedule a retry for it.
  if (cursor) {
    throw new ShopifyError(
      "truncated",
      `fulfillment order pull hit its ${maxPages}-page cap (${orders.length} orders) with more remaining`,
    );
  }
  return { orders, pages };
}

// Current catalogue price + compareAtPrice for a set of variant GIDs, via GraphQL
// `nodes(ids: [...])` — the join that classifies an order line as sale vs full-price
// (a line is "sale" iff the variant's compareAtPrice is above the sold unit price).
// Chunked at Shopify's 250-ids-per-call limit; a deleted variant comes back as a null
// node and is simply omitted from the Map (callers then classify it as full/unknown).
// Throttle retries come for free via shopifyGraphQL.
// Returns Map(variantId -> { price, compareAtPrice }) — both raw strings or null.
const VARIANT_COMPARE_AT_QUERY = `
query VariantCompareAt($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on ProductVariant { id price compareAtPrice }
  }
}`;

export async function fetchVariantCompareAt(cfg, variantIds, { timeBudgetMs = 0 } = {}) {
  const ids = [...new Set((variantIds || []).filter(Boolean))];
  const out = new Map();
  const startedAt = Date.now();
  const chunks = [];
  for (let i = 0; i < ids.length; i += 250) chunks.push(ids.slice(i, i + 250));
  // Two chunks in flight (nodes() queries are cheap — actualQueryCost ~2/id-batch —
  // so a pair never dents the cost bucket, but halves the wall-clock of the lookup).
  const WIDTH = 2;
  for (let i = 0; i < chunks.length; i += WIDTH) {
    // A year-scale pull can see tens of thousands of distinct variants (~40+ chunks).
    // The caller runs inside a serverless function with a hard 60s ceiling, so it can
    // set a budget: better to fail THIS section cleanly (retryable, uncached) than to
    // time the whole payload out and lose the metrics that already loaded.
    if (timeBudgetMs > 0 && Date.now() - startedAt > timeBudgetMs) {
      throw new ShopifyError(
        "timeout",
        `compareAt lookup exceeded its ${timeBudgetMs}ms budget after ${i} of ${chunks.length} chunks`,
      );
    }
    const results = await Promise.all(
      chunks.slice(i, i + WIDTH).map((c) => shopifyGraphQL(cfg, VARIANT_COMPARE_AT_QUERY, { ids: c })),
    );
    for (const data of results) {
      for (const n of data?.nodes ?? []) {
        if (n?.id) out.set(n.id, { price: n.price ?? null, compareAtPrice: n.compareAtPrice ?? null });
      }
    }
  }
  return out;
}
