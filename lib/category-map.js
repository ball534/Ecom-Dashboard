// lib/category-map.js
// SKU prefix → category for the dashboard's Category Mix. Shopify's product_type is
// mostly blank on these stores, so category is derived from the SKU prefix instead.
// EDIT THIS FILE to add/rename categories, then redeploy.
//
// SKU scheme (inferred from live product titles, 2026-06 — CONFIRM with the
// merchandising team): chars 1–2 = collection (AF/BF), chars 3–4 = category code,
// e.g. AFBS "Button Tab Collared Blouse", BFPL "Classic Pintuck Denim Pants".
//
// Rules (implemented in lib/insights.js `categorizeSku`):
//   • matching is case-insensitive;
//   • an exact SKU in `overrides` wins over any prefix;
//   • otherwise the LONGEST matching key in `prefixes` wins (so "AFB" and "AFBS"
//     can coexist);
//   • anything unmatched lands in `fallback` ("Other").
//
// To find prefixes worth adding, run `npm run preview-insights` — it prints an
// "UNMAPPED PREFIXES" table ranked by gross sales. `npm test` validates this file.

// Category codes (SKU chars 3–4), applied across both AF/BF collections below.
const CODES = {
  BA: "Bags & Accessories",
  BB: "Blouses & Shirts",
  BL: "Blouses & Shirts",
  BS: "Blouses & Shirts",
  TB: "Blouses & Shirts",
  BV: "T-Shirts & Tops", // sleeveless / vest tops
  TS: "T-Shirts & Tops",
  TV: "T-Shirts & Tops", // sleeveless tees
  CL: "Knitwear", // cardigans
  KB: "Knitwear",
  KL: "Knitwear", // sweaters / sweatshirts
  KS: "Knitwear",
  KV: "Knitwear", // knit vests
  DQ: "Dresses & Jumpsuits",
  KD: "Dresses & Jumpsuits", // knit dresses
  TD: "Dresses & Jumpsuits", // jersey dresses
  PD: "Dresses & Jumpsuits", // jumpsuits / pinafores
  JK: "Jackets & Outerwear",
  VS: "Jackets & Outerwear", // waistcoats / puffer vests
  PL: "Pants",
  PQ: "Pants", // culottes / bermudas
  PS: "Shorts & Skorts",
  SK: "Skirts",
};

const prefixes = {};
for (const collection of ["AF", "BF"]) {
  for (const [code, category] of Object.entries(CODES)) {
    prefixes[collection + code] = category;
  }
}

export const CATEGORY_MAP = {
  prefixes,
  overrides: {
    // "EXACT-SKU-CODE": "Category name",
  },
  fallback: "Other",
};
