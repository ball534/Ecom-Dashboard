// api/_shopify.js
// Minimal, dependency-free Shopify Admin GraphQL client. The leading underscore
// keeps Vercel from exposing this as an HTTP route. Used by api/dashboard.js and
// scripts/verify-token.js.

import { normalizeOrder } from "../lib/aggregate.js";

// 2025-10 is the earliest Admin API version that exposes `shopifyqlQuery` (ShopifyQL).
// Older versions (<=2025-07) lack the field; the dashboard then falls back to the
// Orders-based reconstruction for sales (Sessions/Conversion show dashes).
const DEFAULT_API_VERSION = "2025-10";

export class ShopifyError extends Error {
  constructor(reason, message, status) {
    super(message || reason);
    this.name = "ShopifyError";
    this.reason = reason; // no-token | no-domain | auth | scope | throttle | http | graphql
    this.status = status;
  }
}

// Read + sanitize config from the environment.
export function getConfig(env = process.env) {
  const strip = (s) => (s || "").trim().replace(/^['"]|['"]$/g, "");
  const token = strip(env.SHOPIFY_TOKEN) || strip(env.SHOPIFY_KEY); // fall back to original .env key name
  let domain = strip(env.SHOPIFY_STORE_DOMAIN)
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const version = strip(env.SHOPIFY_API_VERSION) || DEFAULT_API_VERSION;
  return { token, domain, version };
}

export async function shopifyGraphQL(cfg, query, variables = {}) {
  if (!cfg.domain || cfg.domain === "your-store.myshopify.com") {
    throw new ShopifyError("no-domain", "SHOPIFY_STORE_DOMAIN is not set");
  }
  if (!cfg.token) {
    throw new ShopifyError("no-token", "SHOPIFY_TOKEN is not set");
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

  if (res.status === 401 || res.status === 403) {
    throw new ShopifyError("auth", `Shopify rejected the token (HTTP ${res.status}). The token may be invalid or not a Shopify Admin token.`, res.status);
  }
  if (res.status === 429) {
    throw new ShopifyError("throttle", "Shopify rate limit hit (HTTP 429).", 429);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ShopifyError("http", `Shopify HTTP ${res.status}: ${body.slice(0, 300)}`, res.status);
  }

  const json = await res.json();
  if (json.errors) {
    const msg = JSON.stringify(json.errors);
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

// first:100 keeps the GraphQL cost under the cap now that we read per-line
// originalTotal + taxLines + discountAllocations (to reconstruct Shopify's
// tax-EXCLUDED Gross Sales and Discounts exactly as the Analytics report does).
const ORDERS_QUERY = (includeCustomer) => `
query Orders($cursor: String, $q: String!) {
  orders(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT) {
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

// Page through all orders matching a created_at window, returning normalized records.
// `maxPages` is a safety cap (250 orders/page). For very large multi-year pulls,
// swap this for a Bulk Operation (see README) — the aggregation logic is unchanged.
export async function fetchOrders(cfg, { start, end, includeCustomer = true, maxPages = 400 } = {}) {
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
