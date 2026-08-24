// scripts/verify-token.js
// Checks whether a store's Shopify credentials authenticate. Every store is on the
// client_credentials path, so this also proves that minting a short-lived token from
// CLIENT_/SECRET_ works — the same path the deployed API uses. A store carrying a
// break-glass TOKEN_ override is checked with that token instead, and says so.
//
// Usage:  npm run verify-token            (iORA SG)
//         node scripts/verify-token.js TRTSG
//
// Exit 0 = authenticated. Exit 1 = failed (prints why + how to fix).

import { loadEnv } from "./_env.js";
import { resolveConfig, envNames, envSuffix, verifyToken, ShopifyError } from "../api/_shopify.js";

loadEnv();
const brand = (process.argv[2] || "SG").toUpperCase();
const cfg = await resolveConfig(process.env, brand);

const mask = (t) => (t ? `${t.slice(0, 6)}…${t.slice(-4)} (len ${t.length})` : "(empty)");

console.log("Shopify config:");
console.log("  store  :", envSuffix(brand));
console.log("  domain :", cfg.domain || "(not set)");
console.log("  version:", cfg.version);
console.log(
  "  token  :",
  mask(cfg.token),
  cfg.minted
    ? "(minted just now via client_credentials)"
    : cfg.token
      ? `(pasted verbatim from the ${envNames(brand).token} override — not minted)`
      : "",
);
console.log("");

if (cfg.tokenError) {
  console.error(`❌ Could not mint an access token (reason: ${cfg.tokenError.reason})`);
  console.error("   " + String(cfg.tokenError.message).slice(0, 500));
  console.error("");
  console.error(`→ Check CLIENT_${envSuffix(brand)} / SECRET_${envSuffix(brand)} and that the app`);
  console.error("  is installed on that store with the client_credentials grant enabled.");
  process.exit(1);
}

try {
  const shop = await verifyToken(cfg);
  console.log("✅ Authenticated. Shop info:");
  console.log("   name           :", shop.name);
  console.log("   myshopifyDomain:", shop.myshopifyDomain);
  console.log("   timezone       :", shop.ianaTimezone);
  console.log("   currency       :", shop.currencyCode);
  process.exitCode = 0;
} catch (e) {
  const reason = e instanceof ShopifyError ? e.reason : "error";
  console.error(`❌ Token verification failed (reason: ${reason})`);
  console.error("   " + String(e.message || e).slice(0, 500));
  console.error("");
  if (reason === "no-domain") {
    console.error(`→ Set ${envNames(cfg.brand).domain} in .env to the store's <handle>.myshopify.com`);
    console.error("  Find it in Shopify admin: the admin URL admin.shopify.com/store/<handle>.");
  } else if (reason === "no-token") {
    console.error(`→ Set ${envNames(cfg.brand).client} + ${envNames(cfg.brand).secret} in .env.`);
    console.error("  Shopify admin → Settings → Apps and sales channels → Develop apps →");
    console.error("  (the app for this store) → API credentials → Client ID / Client secret.");
  } else if (reason === "auth") {
    if (cfg.token.startsWith("shpss_") || cfg.token.startsWith("shpca_")) {
      console.error("→ This is a 'shpss_' API SECRET KEY (shared secret), used only for");
      console.error("  webhook/HMAC verification and OAuth — it CANNOT authenticate API calls.");
      console.error("  You need the Admin API ACCESS TOKEN instead (starts with 'shpat_').");
      console.error("  Same app page → 'Admin API access token' → 'Reveal token once'.");
    } else if (cfg.token.startsWith("shpat_")) {
      console.error("→ A 'shpat_' token was rejected. Check it was copied fully, the app is");
      console.error(`  INSTALLED, and ${envNames(cfg.brand).domain} matches the store that issued it.`);
    } else {
      console.error("→ The token was rejected and is not a standard Shopify Admin token.");
    }
    console.error("");
    console.error("  The standard fix is app credentials, not a pasted token: this store's");
    console.error("  admin → Settings → Apps and sales channels → Develop apps → (the app) →");
    console.error("  Configure Admin API scopes (read_orders, read_products, read_reports) →");
    console.error("  Install app → API credentials → copy Client ID and Client secret into");
    console.error(`  ${envNames(cfg.brand).client} / ${envNames(cfg.brand).secret}, and delete any ${envNames(cfg.brand).token} left over.`);
  } else if (reason === "scope") {
    console.error("→ Token works but lacks a required scope/approval. Add read_orders");
    console.error("  (and read_all_orders for >60-day history) to the custom app.");
  }
  process.exitCode = 1;
}
