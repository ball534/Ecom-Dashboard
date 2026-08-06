// lib/ads.js
// Provider-agnostic normalization for the Ads tab. Every ad platform client
// (lib/ads-meta.js, lib/ads-google.js, lib/ads-tiktok.js) returns the SAME shape:
//
//   {
//     currency: "SGD" | null,                       // the ad account's own currency
//     supports: { purchases, revenue, budget },     // what this platform actually served
//     rows: [ { date:"YYYY-MM-DD", campaignId, campaign,
//               spend, impressions, clicks, purchases, revenue } ],
//     notes: [ "…" ],                               // anything the reader must know
//   }
//
// …and this module turns that into the two structures the dashboard renders:
//
//   series    -> ADS[platform][brand]      monthly + weekly roll-up
//   campaigns -> CAMPAIGNS[platform][brand] one row per campaign
//
// Honesty rules, enforced here rather than trusted to each client:
//   • A metric the platform did not serve is `null` for the WHOLE series — never 0.
//     `supports.purchases:false` must render as "—", not as "no purchases".
//   • A month or week with no rows at all is absent, not zero.
//   • Budget has no API source on any of the three platforms (a planned budget is a
//     spreadsheet number, not a reported one), so `budget` is null unless a client
//     genuinely supplies one. The Budget / Utilisation rows then render "—".

export const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export const AD_PLATFORMS = ["fb", "google", "tiktok"];

const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round(n * 100) / 100;

/** The Monday (ISO) of the week containing `date`, computed in UTC to stay TZ-free. */
export function mondayOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 = Sunday
  const back = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/**
 * Roll daily campaign rows into the front-end's per-platform series.
 *
 * @param {object[]} rows      daily rows (see the module contract above)
 * @param {object}   opts      { year, supports, currency }
 * @returns the `pf` object the Ads tab reads, or null when the platform served no rows
 *          for that year (an honest "no data", distinct from a failure).
 */
export function buildPlatformSeries(rows, { year, supports = {}, currency = null } = {}) {
  const hasPurch = supports.purchases !== false;
  const hasRev = supports.revenue !== false;
  const hasBudget = supports.budget === true;

  const months = new Map(); // 0-based month -> accumulator
  const weeks = new Map(); // monday ISO -> accumulator
  const blank = () => ({ spend: 0, impr: 0, clicks: 0, purch: 0, rev: 0, budget: 0 });

  let any = false;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isDate(r?.date)) continue;
    if (year != null && Number(r.date.slice(0, 4)) !== Number(year)) continue;
    any = true;
    const mi = Number(r.date.slice(5, 7)) - 1;
    const wk = mondayOf(r.date);
    for (const [map, key] of [[months, mi], [weeks, wk]]) {
      const acc = map.get(key) || blank();
      acc.spend += num(r.spend);
      acc.impr += num(r.impressions);
      acc.clicks += num(r.clicks);
      acc.purch += num(r.purchases);
      acc.rev += num(r.revenue);
      acc.budget += num(r.budget);
      map.set(key, acc);
    }
  }
  if (!any) return null;

  const mIdx = [...months.keys()].sort((a, b) => a - b);
  const pick = (key, on, fmt) => (on ? mIdx.map((i) => fmt(months.get(i)[key])) : null);

  const series = {
    months: mIdx.map((i) => MONTHS_SHORT[i]),
    monthIndexes: mIdx, // 0-based, so the client never has to re-parse the labels
    year: year != null ? Number(year) : null,
    currency: currency || null,
    spend: pick("spend", true, round2),
    impr: pick("impr", true, Math.round),
    clicks: pick("clicks", true, Math.round),
    purch: pick("purch", hasPurch, Math.round),
    rev: pick("rev", hasRev, round2),
    budget: pick("budget", hasBudget, round2),
    weekly: [...weeks.keys()].sort().map((w) => {
      const a = weeks.get(w);
      return {
        w,
        spend: round2(a.spend),
        impr: Math.round(a.impr),
        clicks: Math.round(a.clicks),
        purch: hasPurch ? Math.round(a.purch) : null,
        rev: hasRev ? round2(a.rev) : null,
      };
    }),
    // No API on any of the three platforms reports a planned yearly budget, so this
    // stays null and the dashboard's budget box shows dashes rather than a guess.
    yearlyBudget: null,
    remaining: null,
    utilYear: null,
  };
  if (hasBudget) {
    const total = series.budget.reduce((t, v) => t + (v || 0), 0);
    const spent = series.spend.reduce((t, v) => t + (v || 0), 0);
    series.yearlyBudget = round2(total);
    series.remaining = round2(total - spent);
    series.utilYear = total ? spent / total : null;
  }
  return series;
}

/**
 * One row per campaign, in the Ads tab's campaign-table shape:
 *   { n:name, s:firstDate, e:lastDate, sp:spend, im:impressions, cl:clicks,
 *     pu:purchases, rv:revenue, g:creativeUrl|null }
 * `pu` / `rv` are null when the platform doesn't report them (never 0).
 */
export function buildCampaignRows(rows, { year, supports = {} } = {}) {
  const hasPurch = supports.purchases !== false;
  const hasRev = supports.revenue !== false;
  const byCampaign = new Map();

  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isDate(r?.date)) continue;
    if (year != null && Number(r.date.slice(0, 4)) !== Number(year)) continue;
    const name = (r.campaign && String(r.campaign).trim()) || null;
    const id = r.campaignId != null ? String(r.campaignId) : null;
    const key = id || name;
    if (!key) continue; // an unlabelled campaign can't be shown as a row
    let c = byCampaign.get(key);
    if (!c) {
      c = {
        n: name || `Campaign ${id}`,
        s: r.date,
        e: r.date,
        sp: 0, im: 0, cl: 0, pu: 0, rv: 0,
        g: r.creative || null,
      };
      byCampaign.set(key, c);
    }
    if (r.date < c.s) c.s = r.date;
    if (r.date > c.e) c.e = r.date;
    if (name && !c.n) c.n = name;
    if (!c.g && r.creative) c.g = r.creative;
    c.sp += num(r.spend);
    c.im += num(r.impressions);
    c.cl += num(r.clicks);
    c.pu += num(r.purchases);
    c.rv += num(r.revenue);
  }

  return [...byCampaign.values()]
    .map((c) => ({
      ...c,
      sp: round2(c.sp),
      im: Math.round(c.im),
      cl: Math.round(c.cl),
      pu: hasPurch ? Math.round(c.pu) : null,
      rv: hasRev ? round2(c.rv) : null,
    }))
    .sort((a, b) => b.sp - a.sp);
}

/**
 * The window a single-year ads pull covers. The Ads tab renders one calendar year at a
 * time (its month columns are labelled by month name alone), so a request spanning
 * years is clamped to the END year and the clamp is reported in meta — the dashboard
 * must never silently merge two Januaries into one column.
 */
export function resolveAdsYear(start, end) {
  const y = Number(String(end).slice(0, 4));
  const clamped = Number(String(start).slice(0, 4)) !== y;
  const from = clamped ? `${y}-01-01` : start;
  return { year: y, start: from, end, clamped };
}
