// api/_token.js
// Mints Shopify Admin API access tokens on demand, so the deployment never has to be
// re-fed hand-generated tokens.
//
// All eight stores are served by Shopify apps whose access tokens expire after ~24 hours.
// Those short-lived tokens are obtained with the OAuth **client_credentials** grant —
// the same two calls the standalone oauth/main.py script made, except here they happen inside the serverless function at
// request time. The credentials that DO live in Vercel's environment are then permanent:
//
//   DOMAIN_<STORE>   e.g. DOMAIN_TRTSG = trt-sg.myshopify.com   (never changes)
//   CLIENT_<STORE>   the app's client id / API key              (never changes)
//   SECRET_<STORE>   the app's client secret (shpss_…)          (never changes)
//
// A store that has TOKEN_<STORE> set keeps using it verbatim. That is a BREAK-GLASS
// OVERRIDE, not a second supported setup: every store, iORA SG included, is expected to
// mint. iORA SG was the last store on a hand-pasted permanent `shpat_` token and has been
// moved onto this path, so there is now one way in rather than two. A stale TOKEN_ left
// behind silently disables minting for that store, so getConfig warns when it finds one
// sitting next to a CLIENT_/SECRET_ pair (api/_shopify.js).
//
// Caching: a minted token is held in module scope, which on Vercel survives for the life
// of the warm lambda instance — so a burst of dashboard requests mints once, not once per
// request. Instances are independent, so a cold start mints again; that is one extra
// ~200ms call, and the grant endpoint is not rate-limited per token the way the Admin API
// is. If minting volume ever needs to be shared ACROSS instances, swap `cache` for Vercel
// KV / Upstash — nothing else in this module changes.

import { ShopifyError } from "./_error.js";

// Renew this long before the nominal expiry, so a token can't lapse mid-request.
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
// Used only if Shopify omits expires_in (it normally returns 86399 = 24h).
const DEFAULT_TTL_MS = 23 * 60 * 60 * 1000;
const MINT_TIMEOUT_MS = 15000;

// store suffix -> { token, expiresAt }
const cache = new Map();
// store suffix -> in-flight mint promise. Without this, the eight concurrent brand
// requests the front-end fires on load would each mint their own token on a cold start.
const inflight = new Map();

const strip = (s) => (s || "").trim().replace(/^['"]|['"]$/g, "");

// App credentials for one store. CLIENT_<S>/SECRET_<S> is the canonical naming (it matches
// TOKEN_<S>/DOMAIN_<S>); the <S>_CLIENT/<S>_SECRET spelling used by oauth/main.py's .env is
// also accepted, so that file's contents can be pasted into Vercel unchanged.
export function getAppCredentials(env, suffix) {
  const S = String(suffix || "").toUpperCase();
  return {
    clientId: strip(env["CLIENT_" + S]) || strip(env[S + "_CLIENT"]) || strip(env[S + "_CLIENT_ID"]),
    clientSecret: strip(env["SECRET_" + S]) || strip(env[S + "_SECRET"]) || strip(env[S + "_CLIENT_SECRET"]),
  };
}

export const hasAppCredentials = (env, suffix) => {
  const { clientId, clientSecret } = getAppCredentials(env, suffix);
  return Boolean(clientId && clientSecret);
};

// One client_credentials exchange. Returns { token, expiresIn } (seconds).
async function mint(domain, clientId, clientSecret) {
  const shop = String(domain).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  let res;
  try {
    res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    throw new ShopifyError(
      timedOut ? "timeout" : "http",
      `Could not reach Shopify's token endpoint for ${shop}: ${e.message}`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 400/401 here means the client id/secret pair is wrong, or the app isn't installed
    // on this shop — a credentials problem, not a transport one.
    const reason = res.status === 400 || res.status === 401 || res.status === 403 ? "auth" : "http";
    throw new ShopifyError(
      reason,
      `Token request for ${shop} failed (HTTP ${res.status}): ${body.slice(0, 300)}`,
      res.status,
    );
  }

  const json = await res.json().catch(() => null);
  const token = json?.access_token;
  if (!token) {
    throw new ShopifyError("auth", `Token request for ${shop} returned no access_token`);
  }
  return { token, expiresIn: Number(json.expires_in) || 0 };
}

// Get a usable access token for one store, minting only when necessary.
//
// `stale` makes a forced refresh idempotent under concurrency: if the cache already holds
// a token OTHER than the one the caller found rejected, someone else has already replaced
// it and that replacement is returned instead of minting again.
export async function getAccessToken(env, suffix, domain, { force = false, stale = null } = {}) {
  const S = String(suffix || "").toUpperCase();
  const hit = cache.get(S);
  const fresh = hit && hit.expiresAt - REFRESH_MARGIN_MS > Date.now();

  if (!force && fresh) return hit.token;
  if (force && fresh && stale && hit.token !== stale) return hit.token;

  if (!force) {
    const pending = inflight.get(S);
    if (pending) return pending;
  }

  const { clientId, clientSecret } = getAppCredentials(env, S);
  if (!clientId || !clientSecret) {
    throw new ShopifyError(
      "no-token",
      `No app credentials for ${S}: set CLIENT_${S} + SECRET_${S} (or, to override minting entirely, TOKEN_${S})`,
    );
  }
  if (!domain) {
    throw new ShopifyError("no-domain", `DOMAIN_${S} is not set`);
  }

  const promise = (async () => {
    const { token, expiresIn } = await mint(domain, clientId, clientSecret);
    cache.set(S, {
      token,
      expiresAt: Date.now() + (expiresIn > 0 ? expiresIn * 1000 : DEFAULT_TTL_MS),
    });
    console.log(
      `[shopify] minted access token for ${S} (${domain}), valid ${
        expiresIn ? (expiresIn / 3600).toFixed(1) + "h" : "unknown"
      }`,
    );
    return token;
  })();

  inflight.set(S, promise);
  try {
    return await promise;
  } finally {
    if (inflight.get(S) === promise) inflight.delete(S);
  }
}

// Test/diagnostic helpers.
export const clearTokenCache = () => {
  cache.clear();
  inflight.clear();
};
export const tokenCacheStatus = () =>
  [...cache.entries()].map(([store, v]) => ({
    store,
    expiresAt: new Date(v.expiresAt).toISOString(),
  }));
