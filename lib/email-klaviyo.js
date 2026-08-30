// lib/email-klaviyo.js
// Klaviyo — per-send email statistics for the two MONOLOQ stores, which send from
// Klaviyo rather than Dotdigital.
//
//   KLAVIYO_API_KEY / _<STORE>           a Private API key with campaigns:read,
//                                        metrics:read (pk_…)
//   KLAVIYO_LIST_<STORE>                 the audience id(s) that identify this store
//   KLAVIYO_CONVERSION_METRIC_<STORE>    the metric that counts as a conversion —
//                                        optional, discovered as "Placed Order"
//   KLAVIYO_REVISION                     API revision date; default below
//
// WHICH STORE A SEND BELONGS TO
// As of 2026-08-31 the only Klaviyo account the Group holds is RE4UJR, and it is
// MONOLOQ SG ALONE — sender "MONOLOQ SG", sg.monoloq.com, Asia/Singapore, SGD, and no
// MY audience among its sends. So the key IS the attribution here, and it is scoped
// per store (KLAVIYO_API_KEY_MONOSG) rather than set bare: a bare KLAVIYO_API_KEY
// would resolve for MONOMY too and report SG's sends twice — once under each store,
// and twice again inside MYALL and GROUP. MONOMY is deliberately "not-configured"
// until MONOLOQ MY has an account of its own.
//
// The shared-account path below stays, because the Dotdigital account genuinely is
// shared and this one may become so: setting any KLAVIYO_LIST_* declares the account
// shared, and from then on a configured store without a filter is "not-configured"
// rather than a silent duplicate of both markets' sends. A campaign is then a store's
// when `audiences.included` holds one of its KLAVIYO_LIST_<STORE> ids — a field that
// rides along in /api/campaigns, so the filter costs no extra call. Run
// `npm run email-discover` to list the audiences in use.
//
// Splitting THIS account by audience would not work anyway: its audiences are
// lifecycle segments (RFM - Champions, ALL CUSTOMER, …), not markets.
//
// SHAPED BY THE RATE LIMIT
// campaign-values-reports is the mirror image of Dotdigital's problem. Dotdigital has
// no bulk report and a generous limit; Klaviyo has a bulk report and a punishing one —
// 1/s burst, 2/min steady, 225/day. So this client makes exactly ONE report call per
// pull, grouped by campaign, and leans on the 5-minute edge cache in api/email.js to
// keep it there. Do not move this call anywhere it could run per page load.
//
// The report carries no campaign names or send dates, so /api/campaigns supplies those
// and the two are joined on campaign id. A campaign with statistics but no send_time
// has not gone out and is dropped rather than dated with the time it was created.
// Dates are converted into the ACCOUNT's timezone before use — see sendDate().

import { createHash } from "node:crypto";

import { ApiError, requestJSON } from "./http.js";
import { envCred, envId } from "./env-keys.js";

const BASE = "https://a.klaviyo.com";
const DEFAULT_REVISION = "2026-07-15";
const CONVERSION_METRIC_NAME = "Placed Order";
const PAGE_CAP = 40; // 100 campaigns a page — a hard stop, not an expected limit

const STATISTICS = [
  "delivered",
  "opens_unique",
  "clicks_unique",
  "conversions",
  "conversion_value",
];

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const csv = (s) =>
  String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** True once any per-store audience filter exists — i.e. this key serves both stores. */
export function isSharedKlaviyoAccount(env) {
  return Object.keys(env || {}).some(
    (k) => /^KLAVIYO_LIST_/.test(k) && String(env[k] || "").trim(),
  );
}

export function klaviyoConfig(env, brand) {
  const key = envCred(env, "KLAVIYO_API_KEY", brand);
  const lists = envId(env, "KLAVIYO_LIST", brand);
  const metric = envId(env, "KLAVIYO_CONVERSION_METRIC", brand);
  const revision = envCred(env, "KLAVIYO_REVISION", brand);
  return {
    key: key.value,
    keyName: key.name,
    lists: csv(lists.value),
    listsName: lists.name,
    metric: metric.value,
    metricName: metric.name,
    revision: String(revision.value || "").trim() || DEFAULT_REVISION,
    shared: isSharedKlaviyoAccount(env),
  };
}

const headers = (cfg, post) => ({
  Authorization: `Klaviyo-API-Key ${cfg.key}`,
  revision: cfg.revision,
  accept: "application/vnd.api+json",
  ...(post ? { "content-type": "application/vnd.api+json" } : {}),
});

// Klaviyo puts its real diagnosis in an `errors` array — including, usefully, the list
// of valid values when a statistic name is wrong. Surface that verbatim: it is the
// difference between "400" and "you asked for opens_uniq, try opens_unique".
function klaviyoAccept(json) {
  const errs = Array.isArray(json?.errors) ? json.errors : [];
  if (!errs.length) return;
  const detail = errs
    .map((e) => [e?.title, e?.detail].filter(Boolean).join(": "))
    .filter(Boolean)
    .join(" | ")
    .slice(0, 400);
  const code = String(errs[0]?.code || "");
  const status = Number(errs[0]?.status || 0);
  if (status === 401 || /authentication/i.test(code)) throw new ApiError("auth", `Klaviyo: ${detail}`);
  if (status === 403 || /permission|scope/i.test(code)) throw new ApiError("scope", `Klaviyo: ${detail}`);
  if (status === 429 || /throttl|rate_limit/i.test(code)) throw new ApiError("throttle", `Klaviyo: ${detail}`);
  throw new ApiError("api", `Klaviyo: ${detail || "request failed"}`);
}

/** Follow `links.next` cursors, collecting `data`. */
async function paged(url, cfg, label, budget) {
  const out = [];
  let next = url;
  for (let page = 0; next && page < PAGE_CAP; page++) {
    budget?.check(label);
    const json = await requestJSON(next, {
      headers: headers(cfg),
      label,
      timeoutMs: 20000,
      retries: 1,
      accept: klaviyoAccept,
    });
    out.push(...(Array.isArray(json?.data) ? json.data : []));
    next = json?.links?.next || null;
  }
  return out;
}

/**
 * The metric id that defines a conversion. conversion_value is calculated against it,
 * so a wrong id silently reports a different funnel's money — hence the exact-name
 * match and the explicit error rather than "first metric that looks commercial".
 */
async function conversionMetricId(cfg, budget) {
  if (cfg.metric) return { id: cfg.metric, discovered: false };

  const metrics = await paged(
    `${BASE}/api/metrics?fields[metric]=name,integration`,
    cfg,
    "Klaviyo metrics",
    budget,
  );
  const hit = metrics.find(
    (m) =>
      String(m?.attributes?.name || "").trim().toLowerCase() ===
      CONVERSION_METRIC_NAME.toLowerCase(),
  );
  if (!hit?.id) {
    throw new ApiError(
      "not-configured",
      `Klaviyo has no "${CONVERSION_METRIC_NAME}" metric to attribute revenue against. ` +
        `Set ${cfg.metricName} to the metric id this account uses.`,
    );
  }
  return { id: String(hit.id), discovered: true };
}

/**
 * Which Klaviyo account this key belongs to, and what currency it reports in.
 *
 * Best-effort labelling only — /api/accounts needs an `accounts:read` scope the key may
 * not carry, and a missing label must never fail a pull that otherwise worked. The
 * fallback id is a truncated digest of the key: enough for the preview script to spot
 * MONOSG and MONOMY pointing at ONE account (which would double-count in the Group
 * roll-up), and not reversible back into the credential.
 */
async function accountLabel(cfg, budget) {
  const fingerprint = `klaviyo:key-${createHash("sha256").update(cfg.key).digest("hex").slice(0, 12)}`;
  try {
    budget?.check("Klaviyo account");
    const json = await requestJSON(`${BASE}/api/accounts`, {
      headers: headers(cfg),
      label: "Klaviyo account",
      timeoutMs: 15000,
      retries: 0,
      accept: klaviyoAccept,
    });
    const row = Array.isArray(json?.data) ? json.data[0] : null;
    return {
      id: row?.id ? `klaviyo:${row.id}` : fingerprint,
      currency: row?.attributes?.preferred_currency || null,
      timezone: row?.attributes?.timezone || null,
      exact: !!row?.id,
    };
  } catch {
    return { id: fingerprint, currency: null, timezone: null, exact: false };
  }
}

/**
 * The calendar date a send belongs to, in the ACCOUNT's timezone.
 *
 * `send_time` is UTC, but Klaviyo's own UI — and the campaign-values report's bucketing
 * — work in the account's timezone, so slicing the UTC string dates an evening send to
 * the day before. On MONOLOQ SG (UTC+8) that is 15 of the account's sends, and "MNQ 2025
 * greeting" (2024-12-31T…Z = 2025-01-01 local) moves across a YEAR — which is exactly
 * what buildEmailSends filters on, so the send would sit in FY2024 here and FY2025 in
 * Klaviyo. Falls back to the UTC slice when the timezone could not be read, since a
 * date one day out still beats failing the pull.
 */
function sendDate(sendTime, timeZone) {
  const raw = String(sendTime || "");
  if (!raw || !timeZone) return raw.slice(0, 10);
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw.slice(0, 10);
  try {
    // en-CA renders as YYYY-MM-DD, which is the shape the rest of the pipeline expects.
    return new Date(t).toLocaleDateString("en-CA", { timeZone });
  } catch {
    return raw.slice(0, 10); // an unrecognised IANA zone must not lose the send
  }
}

/**
 * id -> { name, date } for every email campaign this STORE has actually sent.
 *
 * `audiences` is requested alongside the name so the brand split costs no extra call:
 * on a shared account a campaign is this store's only when one of its included
 * audiences is one of the store's configured list ids.
 */
async function sentCampaigns(cfg, { start, end, timeZone }, budget) {
  const url =
    `${BASE}/api/campaigns` +
    `?filter=${encodeURIComponent("equals(messages.channel,'email')")}` +
    `&fields[campaign]=name,send_time,status,audiences&page[size]=100`;

  const rows = await paged(url, cfg, "Klaviyo campaigns", budget);
  const want = new Set(cfg.lists);
  const map = new Map();
  let seen = 0;
  for (const c of rows) {
    const sent = sendDate(c?.attributes?.send_time, timeZone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sent)) continue; // never sent — not a send
    if (sent < start || sent > end) continue;
    seen++;
    if (want.size) {
      const included = c?.attributes?.audiences?.included;
      if (!Array.isArray(included) || !included.some((a) => want.has(String(a)))) continue;
    }
    map.set(String(c.id), { name: c?.attributes?.name || null, date: sent });
  }
  return { map, seen };
}

/** Sends for one brand's window, in lib/email.js's provider contract. */
export async function fetchKlaviyoEmail(env, brand, { start, end, deadline } = {}) {
  const cfg = klaviyoConfig(env, brand);
  if (!cfg.key) {
    throw new ApiError(
      "not-configured",
      `Klaviyo is not configured for brand "${brand}". Missing: ${cfg.keyName}.`,
    );
  }
  // On a shared key, "no audience filter" means both markets' sends — wrong under one
  // store's name, and counted twice again in GROUP. Refuse rather than duplicate.
  if (cfg.shared && !cfg.lists.length) {
    throw new ApiError(
      "not-configured",
      `This Klaviyo account serves more than one store, so "${brand}" needs an audience ` +
        `filter of its own or it would show both markets' sends. Set ${cfg.listsName} to ` +
        `its list id(s). Run \`npm run email-discover\` to list the audiences in use.`,
    );
  }

  const account = await accountLabel(cfg, deadline);
  const metric = await conversionMetricId(cfg, deadline);
  const { map: campaigns, seen } = await sentCampaigns(
    cfg,
    { start, end, timeZone: account.timezone },
    deadline,
  );

  deadline?.check("Klaviyo campaign values");
  const report = await requestJSON(`${BASE}/api/campaign-values-reports`, {
    method: "POST",
    headers: headers(cfg, true),
    body: JSON.stringify({
      data: {
        type: "campaign-values-report",
        attributes: {
          statistics: STATISTICS,
          // Klaviyo evaluates this in the ACCOUNT's timezone whatever offset is sent,
          // so a send near midnight can land a day either side of the same send in
          // Shopify. Immaterial monthly; worth knowing before reconciling a single day.
          timeframe: { start: `${start}T00:00:00+00:00`, end: `${end}T23:59:59+00:00` },
          conversion_metric_id: metric.id,
          // campaign_message_id is REQUIRED alongside campaign_id — without it the
          // report 400s with "Grouping by campaign_message_id is required". An email
          // campaign is normally one message, so this usually adds no rows; where it
          // does (A/B variants), the rows are summed back per campaign below.
          group_by: ["campaign_id", "campaign_message_id"],
        },
      },
    }),
    label: "Klaviyo campaign values",
    timeoutMs: 30000,
    // One report call per pull, by design. Retrying eats a 2/min budget for a request
    // that is usually failing for a reason a retry cannot fix.
    retries: 1,
    accept: klaviyoAccept,
  });

  const results = report?.data?.attributes?.results;
  if (!Array.isArray(results)) {
    throw new ApiError("api", "Klaviyo campaign-values-report returned no results array.");
  }

  // Keyed by campaign, not by row: the report groups by message as well, so a campaign
  // with more than one message (an A/B test) arrives as several rows that are one send
  // to every reader of this dashboard. Summing here keeps the panel's send count equal
  // to the campaign count instead of showing a variant as a second campaign.
  const byCampaign = new Map();
  const unmatchedIds = new Set();
  for (const r of results) {
    const id = String(r?.groupings?.campaign_id || "");
    const known = campaigns.get(id);
    // A result with no campaign in the window has no date we can trust — bucketing it
    // into a month would be a guess, and dropping it is visible in the note below.
    if (!known) {
      unmatchedIds.add(id);
      continue;
    }
    const st = r?.statistics || {};
    const row = byCampaign.get(id) || {
      id,
      name: known.name,
      date: known.date,
      delivered: 0,
      opened: 0,
      clicked: 0,
      revenue: 0,
      orders: 0,
      revenueRaw: null,
    };
    row.delivered += num(st.delivered);
    row.opened += num(st.opens_unique);
    row.clicked += num(st.clicks_unique);
    row.revenue += num(st.conversion_value);
    row.orders += num(st.conversions);
    byCampaign.set(id, row);
  }
  const sends = [...byCampaign.values()];
  const unmatched = unmatchedIds.size;

  const notes = [
    "Opens and clicks are Klaviyo's unique counts (opens_unique / clicks_unique), so " +
      "% Click and Click-to-Open are rates of people, not of clicks.",
    `Revenue and orders are attributed against the "${
      metric.discovered ? CONVERSION_METRIC_NAME : metric.id
    }" metric${metric.discovered ? " (discovered)" : ` (${cfg.metricName})`}.`,
  ];
  if (unmatched) {
    notes.push(
      `${unmatched} reported campaign${unmatched === 1 ? "" : "s"} had no send time in ` +
        `this window and ${unmatched === 1 ? "is" : "are"} absent from these totals.`,
    );
  }

  if (cfg.lists.length) {
    notes.push(
      `${campaigns.size} of the account's ${seen} sends in this window matched ` +
        `${cfg.listsName} (audience ${cfg.lists.join(", ")}).`,
    );
  } else {
    notes.push(
      "No audience filter is set, so this is every send in the account. That is correct " +
        "only while one store uses it — see KLAVIYO_LIST_<STORE> in .env.example.",
    );
  }
  if (!account.exact) {
    notes.push(
      "Account identity is a key fingerprint, not the account id — add accounts:read to " +
        "the key so the reporting currency and timezone can be read from Klaviyo rather " +
        "than assumed. Send dates fall back to UTC meanwhile, which can date an evening " +
        "send to the day before.",
    );
  }

  return {
    currency: account.currency,
    supports: { revenue: true }, // decided in api/email.js, across the whole window
    sends,
    notes,
    account: {
      // The audience filter, not the key, is what distinguishes the two MONOLOQ stores
      // on one account — so it is part of the identity the mapping check compares.
      id: `${account.id}${cfg.lists.length ? `#list:${cfg.lists.join("+")}` : ""}`,
      label: `${cfg.keyName}${cfg.lists.length ? ` · ${cfg.listsName}` : ""}`,
      shared: cfg.shared,
      filter: cfg.lists.length ? "list" : null,
    },
    stats: { campaigns: seen, matched: campaigns.size, fetched: sends.length, cached: 0 },
  };
}
