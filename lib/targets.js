// lib/targets.js
// Monthly sales targets, maintained BY HAND per brand per year, in the brand's local
// currency (SG/TRTSG/SANSSG/MONOSG = SGD; MY/TRTMY/SANSMY/MONOMY = MYR). Same
// {year:[12 months]} convention as the dashboard metrics: index 0 = January;
// null = no target set for that month.
//
// EDIT THE NUMBERS, run `npm test` (validates the shape), commit, redeploy.
export const TARGETS = {
  // SG: {
  //   2026: [150000, 140000, 145000, 138000, 142000, 148000, null, null, null, null, null, null],
  // },
};

// Throws with a precise message when the targets object is malformed, so a bad
// hand-edit fails `npm test` (and degrades to a per-section error at request time
// rather than a 500 — see api/insights.js).
export function validateTargets(targets) {
  if (targets == null || typeof targets !== "object" || Array.isArray(targets)) {
    throw new Error("TARGETS must be an object keyed by brand");
  }
  for (const [brand, years] of Object.entries(targets)) {
    if (years == null || typeof years !== "object" || Array.isArray(years)) {
      throw new Error(`TARGETS.${brand} must be an object keyed by year`);
    }
    for (const [year, arr] of Object.entries(years)) {
      if (!/^\d{4}$/.test(year)) {
        throw new Error(`TARGETS.${brand}: year key "${year}" must be a 4-digit year`);
      }
      if (!Array.isArray(arr) || arr.length !== 12) {
        throw new Error(`TARGETS.${brand}.${year} must be an array of exactly 12 entries (Jan..Dec)`);
      }
      arr.forEach((v, i) => {
        if (v === null) return;
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
          throw new Error(
            `TARGETS.${brand}.${year}[${i}] must be null or a non-negative number (got ${JSON.stringify(v)})`,
          );
        }
      });
    }
  }
  return true;
}

// Extract one brand's targets for the requested years, as copies, in the dashboard's
// { year: [12] } shape. Returns null when the brand has no targets for ANY of the
// requested years. Validates just the brand's slice defensively.
export function getTargets(targets, brand, years) {
  const b = targets?.[brand];
  if (!b) return null;
  validateTargets({ [brand]: b });
  const out = {};
  for (const y of Array.isArray(years) ? years : []) {
    const arr = b[String(y)];
    if (arr) out[y] = arr.slice();
  }
  return Object.keys(out).length ? out : null;
}
