// scripts/verify-token.js
// Checks whether the configured Shopify token + domain authenticate.
// Usage:  npm run verify-token
//
// Exit 0 = authenticated. Exit 1 = failed (prints why + how to fix).

import { loadEnv } from "./_env.js";
import { getConfig, verifyToken, ShopifyError } from "../api/_shopify.js";

loadEnv();
const cfg = getConfig();

const mask = (t) => (t ? `${t.slice(0, 6)}…${t.slice(-4)} (len ${t.length})` : "(empty)");

console.log("Shopify config:");
console.log("  domain :", cfg.domain || "(not set)");
console.log("  version:", cfg.version);
console.log("  token  :", mask(cfg.token));
console.log("");

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
    console.error("→ Set SHOPIFY_STORE_DOMAIN in .env to the store's <handle>.myshopify.com");
    console.error("  Find it in Shopify admin: the admin URL admin.shopify.com/store/<handle>.");
  } else if (reason === "no-token") {
    console.error("→ Set SHOPIFY_TOKEN in .env.");
  } else if (reason === "auth") {
    if (cfg.token.startsWith("shpss_") || cfg.token.startsWith("shpca_")) {
      console.error("→ This is a 'shpss_' API SECRET KEY (shared secret), used only for");
      console.error("  webhook/HMAC verification and OAuth — it CANNOT authenticate API calls.");
      console.error("  You need the Admin API ACCESS TOKEN instead (starts with 'shpat_').");
      console.error("  Same app page → 'Admin API access token' → 'Reveal token once'.");
    } else if (cfg.token.startsWith("shpat_")) {
      console.error("→ A 'shpat_' token was rejected. Check it was copied fully, the app is");
      console.error("  INSTALLED, and SHOPIFY_STORE_DOMAIN matches the store that issued it.");
    } else {
      console.error("→ The token was rejected and is not a standard Shopify Admin token.");
    }
    console.error("");
    console.error("  To get the right token: iORA SG admin → Settings → Apps and sales");
    console.error("  channels → Develop apps → (create/open the app) → API credentials →");
    console.error("  Configure Admin API scopes (read_orders, read_products) → Install app →");
    console.error("  reveal the 'shpat_...' Admin API access token → put it in SHOPIFY_TOKEN.");
  } else if (reason === "scope") {
    console.error("→ Token works but lacks a required scope/approval. Add read_orders");
    console.error("  (and read_all_orders for >60-day history) to the custom app.");
  }
  process.exitCode = 1;
}
