// lib/env-keys.js
// How a dashboard brand key maps onto environment-variable names for the external
// sources (ad platforms, marketplaces).
//
// The Shopify layer already owns this idea (api/_shopify.js: DOMAIN_IORASG, CLIENT_TRTMY,
// …). The same store suffixes are reused here so ONE naming convention covers every
// source: brand SG -> IORASG, brand MY -> IORAMY, everything else is its own key.
//
//   Account / shop identifiers  — per store, e.g. META_AD_ACCOUNT_IORASG
//                                 (for the two iORA stores, META_AD_ACCOUNT_SG /_MY are
//                                 accepted too: that is the spelling in INTEGRATION-PLAN.md)
//   Shared credentials          — one app/token usually covers every store, so they fall
//                                 back: <BASE>_<STORE> -> <BASE>_<MARKET> -> <BASE>
//                                 e.g. META_ACCESS_TOKEN_TRTSG -> META_ACCESS_TOKEN_SG
//                                      -> META_ACCESS_TOKEN
//
// A market-level fallback is deliberately NOT applied to identifiers: silently reading
// iORA SG's ad account for, say, TRT SG would attribute one brand's spend to another.

const STORE_SUFFIX = { SG: "IORASG", MY: "IORAMY" };

/** The 8 live stores, exactly as api/dashboard.js and api/insights.js know them. */
export const LIVE_BRANDS = [
  "SG", "MY", "TRTSG", "TRTMY", "SANSSG", "SANSMY", "MONOSG", "MONOMY",
];

/** Roll-up brands are computed client-side from members — they are never fetched. */
export const AGG_MEMBERS = {
  SGALL: ["SG", "TRTSG", "SANSSG", "MONOSG"],
  MYALL: ["MY", "TRTMY", "SANSMY", "MONOMY"],
  GROUP: ["SG", "TRTSG", "SANSSG", "MONOSG", "MY", "TRTMY", "SANSMY", "MONOMY"],
};

export function normalizeBrand(brand) {
  const b = String(brand || "SG").toUpperCase();
  return LIVE_BRANDS.includes(b) ? b : "SG";
}

/** Env suffix for a store, matching api/_shopify.js. */
export function storeSuffix(brand) {
  const b = normalizeBrand(brand);
  return STORE_SUFFIX[b] || b;
}

/** "SG" | "MY" — the market a store trades in (drives currency + API host choices). */
export function marketOf(brand) {
  return /MY$/.test(normalizeBrand(brand)) ? "MY" : "SG";
}

/** The store's reporting currency, for labelling only — never used to convert. */
export function currencyOf(brand) {
  return marketOf(brand) === "MY" ? "MYR" : "SGD";
}

const strip = (s) => (typeof s === "string" ? s.trim().replace(/^['"]|['"]$/g, "") : "");

/** Suffixes tried for a per-store IDENTIFIER, most specific first. */
export function idSuffixes(brand) {
  const b = normalizeBrand(brand);
  const s = storeSuffix(b);
  // SG/MY are the plan's shorthand for the two iORA stores, and only for those.
  return b === "SG" || b === "MY" ? [s, b] : [s];
}

/** Suffixes tried for a SHARED credential, most specific first (plus the bare name). */
export function credSuffixes(brand) {
  const out = idSuffixes(brand);
  const m = marketOf(brand);
  if (!out.includes(m)) out.push(m);
  return out;
}

function firstEnv(env, base, suffixes, { allowBare = false } = {}) {
  for (const s of suffixes) {
    const v = strip(env[`${base}_${s}`]);
    if (v) return { value: v, name: `${base}_${s}` };
  }
  if (allowBare) {
    const v = strip(env[base]);
    if (v) return { value: v, name: base };
  }
  // Nothing set: name every spelling that WOULD have been read, so a "not configured"
  // message points at a variable the reader can actually find in .env.example.
  return {
    value: "",
    name: suffixes.map((s) => `${base}_${s}`).join(" or ") + (allowBare ? ` or ${base}` : ""),
  };
}

/** Per-store identifier (ad account, shop id). No market-level fallback — see above. */
export function envId(env, base, brand) {
  return firstEnv(env, base, idSuffixes(brand));
}

/** Shared credential: store -> market -> bare. */
export function envCred(env, base, brand) {
  return firstEnv(env, base, credSuffixes(brand), { allowBare: true });
}

/** Convenience: just the value. */
export const envIdValue = (env, base, brand) => envId(env, base, brand).value;
export const envCredValue = (env, base, brand) => envCred(env, base, brand).value;
