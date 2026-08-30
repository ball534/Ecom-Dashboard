// lib/email.js
// Provider-agnostic normalization for the dashboard's email panel (the teal
// "Dotdigital" card on the Ads tab). Both email clients — lib/email-dotdigital.js and
// lib/email-klaviyo.js — return the SAME shape:
//
//   {
//     currency: "SGD" | null,          // the sending account's own reporting currency
//     supports: { revenue },           // whether attributed revenue/orders are real
//     sends: [ { date:"YYYY-MM-DD", id, name,
//                delivered, opened, clicked, revenue, orders } ],
//     notes: [ "…" ],                  // anything the reader must know
//     account: { id, label },          // WHICH email account these sends came from
//   }
//
// …and this module turns that into the one structure the front end renders:
//
//   DOTD[brand].campaigns -> [ { s, n, dl, op, cl, rv, or } ]
//
// That key soup is the front end's, not ours: public/index.html's dotdTable /
// dotdFunnel / dotdCampaignTable were written against a hand-exported file and read
// exactly those names. Producing them here is what lets the whole panel go live
// without touching a line of rendering code.
//
// Honesty rules, enforced here rather than trusted to each client:
//   • `opened` is UNIQUE opens and `clicked` is UNIQUE clickers. The panel divides
//     clicks by opens for click-to-open, so pairing a total with a unique would
//     inflate every CTOR on the page. Both clients must hand over unique counts.
//   • `supports.revenue:false` nulls revenue AND orders for the WHOLE window — never 0.
//     An email platform only attributes revenue when its commerce/ROI tracking is
//     connected to the store; where it is not, every campaign reads 0, and rendering
//     that as "$0 earned" would be a lie about the campaigns rather than about the
//     tracking. "—" is the honest answer. See revenueSupported() below.

const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const round2 = (n) => Math.round(n * 100) / 100;

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Money as an email platform reports it — Dotdigital returns `revenue` as a
 * PRE-FORMATTED string ("1,234.56", "RM1.234,56", "S$980.00"), not a number.
 *
 * The separator that is followed by exactly one or two digits at the very end is the
 * decimal point; every other dot/comma is a thousands grouping. That reads both the
 * en- and the de-style groupings correctly without having to know the account's locale.
 */
export function parseMoney(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const raw = v.trim();
  if (!raw) return null;
  const negative = /^\(.*\)$/.test(raw) || /-\s*[\d.,]/.test(raw);
  const digits = raw.replace(/[^0-9.,]/g, "");
  if (!/[0-9]/.test(digits)) return null;

  const sep = Math.max(digits.lastIndexOf("."), digits.lastIndexOf(","));
  const normalized =
    sep > -1 && /^[0-9]{1,2}$/.test(digits.slice(sep + 1))
      ? `${digits.slice(0, sep).replace(/[.,]/g, "")}.${digits.slice(sep + 1)}`
      : digits.replace(/[.,]/g, "");

  const n = parseFloat(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * The currency a formatted money string names, where it names one at all. Labelling
 * only — nothing here converts. A bare "$" is deliberately NOT resolved: it is SGD in
 * one account and USD in another, and guessing would mislabel a whole column.
 */
export function currencyFromMoney(v) {
  if (typeof v !== "string") return null;
  const code = v.match(/\b(SGD|MYR|USD|GBP|EUR|AUD|HKD|IDR|THB|PHP|VND|CNY|JPY)\b/i);
  if (code) return code[1].toUpperCase();
  if (/RM\s*[\d.,]/i.test(v)) return "MYR";
  if (/S\$/.test(v)) return "SGD";
  return null;
}

/**
 * Does this account actually attribute revenue?
 *
 * There is no API flag for "commerce tracking is connected", so the only available
 * signal is the data: an account with ROI tracking off returns 0 revenue and 0 orders
 * for every single send. A brand that ran a year of campaigns and attributed literally
 * nothing is, in practice, a brand whose tracking is not wired up — and between
 * rendering "—" for a live-but-untracked account and rendering "$0" for one, "—" is
 * the error this dashboard prefers.
 *
 * Judged across the WHOLE window, never per send: one campaign that genuinely sold
 * nothing while its neighbours sold is a real zero and stays a zero.
 */
export function revenueSupported(sends) {
  return (Array.isArray(sends) ? sends : []).some(
    (s) => num(s?.revenue) > 0 || num(s?.orders) > 0,
  );
}

/**
 * One row per send, in the front end's campaign shape:
 *   { s:sendDate, n:name, dl:delivered, op:uniqueOpens, cl:uniqueClickers,
 *     rv:revenue, or:orders }
 * `rv` / `or` are null when the account attributes no revenue (never 0).
 *
 * @returns the array, or null when no send falls in the year — an honest "no data",
 *          distinct from a failure, exactly like buildPlatformSeries in lib/ads.js.
 */
export function buildEmailSends(sends, { year, supports = {} } = {}) {
  const hasRev = supports.revenue !== false;
  const out = [];

  for (const s of Array.isArray(sends) ? sends : []) {
    if (!isDate(s?.date)) continue;
    if (year != null && Number(s.date.slice(0, 4)) !== Number(year)) continue;
    out.push({
      s: s.date,
      n:
        (s.name && String(s.name).trim()) ||
        (s.id != null ? `Campaign ${s.id}` : "Untitled send"),
      dl: Math.round(num(s.delivered)),
      op: Math.round(num(s.opened)),
      cl: Math.round(num(s.clicked)),
      rv: hasRev ? round2(num(s.revenue)) : null,
      or: hasRev ? Math.round(num(s.orders)) : null,
    });
  }

  // Chronological: the panel buckets by month in the order it receives rows.
  out.sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.n < b.n ? -1 : 1));
  return out.length ? out : null;
}
