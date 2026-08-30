// lib/email-dotdigital.js
// Dotdigital (v2 REST) — per-send email statistics for the six stores that send from
// Dotdigital: iORA, SANS & SANS and The Restyle Trait, SG and MY.
//
//   DOTDIGITAL_USER / _PASS              the API user, apiuser-xxxx@apiconnector.com
//   DOTDIGITAL_REGION                    r1 (Europe) | r2 (North America) | r3 (APAC)
//                                        optional — discovered from the account
//   DOTDIGITAL_FROM_<STORE>              from-address(es) that identify this brand
//   DOTDIGITAL_ADDRESS_BOOKS_<STORE>     address book id(s) that identify this brand
//
// ONE ACCOUNT, SIX BRANDS
// IORA Group sends every brand from a SINGLE Dotdigital account, so the credential
// cannot be the attribution the way META_AD_ACCOUNT_<STORE> is: one login sees all six
// brands' campaigns. Handing that whole list to every brand would show iORA's sends
// under SANS and have SGALL/GROUP total the same campaign three and six times over.
//
// So the brand split is an explicit, id-based mapping, and there are two ways to draw
// it because one account can be organised either way:
//
//   DOTDIGITAL_FROM_<STORE>           matched against the campaign's fromAddress.email.
//                                     FREE — the address is already in the campaign
//                                     list, so non-matching campaigns are dropped
//                                     before a single summary call is spent.
//   DOTDIGITAL_ADDRESS_BOOKS_<STORE>  matched against the books a campaign was sent to.
//                                     Costs one extra GET per campaign IN THE WHOLE
//                                     ACCOUNT (you cannot know a campaign is not yours
//                                     without looking), cached permanently since a sent
//                                     campaign's address books never change afterwards.
//
// Per store, FROM wins where both are set — a brand whose SG and MY share one sender
// splits on books while its siblings split on address, and each store says which.
// Run `npm run email-discover` to see what this account actually offers.
//
// What is deliberately NOT supported is splitting on campaign NAME. "IORA RED PACKET"
// is one rename away from not matching, and a rename must never silently re-attribute
// revenue — the same rule that keeps ad accounts mapped by id in .env.example.
//
// THE SHARED-ACCOUNT GUARD
// Setting any DOTDIGITAL_FROM_* or DOTDIGITAL_ADDRESS_BOOKS_* variable declares that
// this account is shared. From then on every configured store must carry a filter of
// its own; one that does not is "not-configured" rather than a silent duplicate of the
// whole account. The env itself is the signal — there is no separate switch to forget.
//
// THE EXPENSIVE BIT
// v2 has no bulk report: statistics are one GET per campaign
// (/v2/campaigns/{id}/summary), and this account carries all six brands' sends. So
// summaries are cached in the token store, keyed by account and year: a send older than
// FRESH_DAYS can never change again, so only the recent tail is re-fetched. Partial
// progress is persisted even when the pull runs out of budget, so a cold cache
// converges over a couple of refreshes instead of restarting from nothing.

import { ApiError, requestJSON, settledPool } from "./http.js";
import { envCred, envId } from "./env-keys.js";
import { loadToken, saveToken } from "./token-store.js";
import { parseMoney, currencyFromMoney } from "./email.js";

const REGIONS = ["r1", "r2", "r3"];
// r1 is Dotdigital's own default and the one host that will answer account-info from
// any region — which is what makes region discovery possible without being told.
const DISCOVERY_REGION = "r1";
const hostFor = (r) => `https://${r}-api.dotdigital.com`;

// A send stops moving once its audience has stopped opening it. 30 days is well past
// the tail of an email campaign; anything older is treated as frozen and never re-read.
const FRESH_DAYS = 30;
const PAGE = 1000; // the endpoint's documented maximum for `select`
const CONCURRENCY = 5;

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const csv = (s) =>
  String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** True once any per-store filter exists — i.e. this account serves more than one brand. */
export function isSharedAccount(env) {
  return Object.keys(env || {}).some(
    (k) => /^DOTDIGITAL_(FROM|ADDRESS_BOOKS)_/.test(k) && String(env[k] || "").trim(),
  );
}

export function dotdigitalConfig(env, brand) {
  const user = envCred(env, "DOTDIGITAL_USER", brand);
  const pass = envCred(env, "DOTDIGITAL_PASS", brand);
  const region = envCred(env, "DOTDIGITAL_REGION", brand);
  const from = envId(env, "DOTDIGITAL_FROM", brand);
  const books = envId(env, "DOTDIGITAL_ADDRESS_BOOKS", brand);
  return {
    user: user.value,
    userName: user.name,
    pass: pass.value,
    passName: pass.name,
    region: String(region.value || "").trim().toLowerCase(),
    // Lower-cased: a from-address is not case-sensitive and a capitalised env value
    // must not silently match nothing.
    from: csv(from.value).map((x) => x.toLowerCase()),
    fromName: from.name,
    books: csv(books.value),
    booksName: books.name,
    shared: isSharedAccount(env),
  };
}

const authHeaders = (cfg) => ({
  Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.pass}`).toString("base64")}`,
  Accept: "application/json",
});

// Region + account id per API user. Module scope: a warm instance resolves once.
const accountCache = new Map();

export function clearDotdigitalAccountCache() {
  accountCache.clear();
}

/**
 * Resolve the account's region and id. Doubles as the credential check: a bad API user
 * fails here with reason:"auth" and a message naming the variable, rather than
 * surfacing as an empty campaign list that looks like "no sends this year".
 */
export async function dotdigitalAccountInfo(cfg) {
  const hit = accountCache.get(cfg.user);
  if (hit) return hit;

  const base = hostFor(REGIONS.includes(cfg.region) ? cfg.region : DISCOVERY_REGION);
  const json = await requestJSON(`${base}/v2/account-info`, {
    headers: authHeaders(cfg),
    label: "Dotdigital account-info",
    timeoutMs: 15000,
    retries: 1,
  });

  const props = Array.isArray(json?.properties) ? json.properties : [];
  const endpoint = String(
    props.find((p) => String(p?.name || "").toLowerCase() === "apiendpoint")?.value || "",
  );
  const found = /https?:\/\/(r\d)-api\./i.exec(endpoint);

  const info = {
    // An explicitly configured region wins: it is the deployment's stated intent, and
    // a mismatch should surface as Dotdigital's own 403 rather than be silently fixed.
    region: REGIONS.includes(cfg.region)
      ? cfg.region
      : found
        ? found[1].toLowerCase()
        : DISCOVERY_REGION,
    discovered: !REGIONS.includes(cfg.region),
    id: json?.id != null ? String(json.id) : null,
  };
  accountCache.set(cfg.user, info);
  return info;
}

/** Every SENT campaign with activity since `since`, following paging. */
export async function listSentCampaigns(base, cfg, since, budget) {
  const out = [];
  for (let skip = 0; ; skip += PAGE) {
    budget?.check("Dotdigital campaign list");
    const json = await requestJSON(
      `${base}/v2/campaigns/with-activity-since/${encodeURIComponent(since)}`,
      {
        headers: authHeaders(cfg),
        // `skip` is documented with a minimum of 1, so the first page omits it.
        query: { select: PAGE, skip: skip || undefined },
        label: "Dotdigital campaign list",
        timeoutMs: 25000,
      },
    );
    const page = Array.isArray(json) ? json : [];
    for (const c of page) {
      if (c?.id == null) continue;
      if (String(c.status || "").toLowerCase() !== "sent") continue;
      out.push({
        id: String(c.id),
        name: c.name || c.subject || null,
        from: String(c.fromAddress?.email || "").trim().toLowerCase() || null,
      });
    }
    if (page.length < PAGE) break;
  }
  return out;
}

/** The address book ids one campaign was sent to. */
export async function campaignAddressBooks(base, cfg, id, budget) {
  budget?.check("Dotdigital address books");
  const json = await requestJSON(`${base}/v2/campaigns/${id}/address-books`, {
    headers: authHeaders(cfg),
    query: { select: PAGE },
    label: `Dotdigital address books (${id})`,
    timeoutMs: 15000,
    retries: 1,
  });
  return (Array.isArray(json) ? json : [])
    .map((b) => (b?.id != null ? String(b.id) : null))
    .filter(Boolean);
}

/** One campaign's statistics, mapped into lib/email.js's send shape. */
function toSend(id, name, s) {
  const date = String(s?.dateSent || "").slice(0, 10);
  return {
    id,
    name: name || null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    delivered: num(s?.numTotalDelivered),
    opened: num(s?.numTotalUniqueOpens),
    // numRecipientsClicked (unique clickers), NOT numTotalClicks. The panel computes
    // click-to-open as clicks/opens against UNIQUE opens; feeding it a total that
    // counts one recipient's three clicks three times inflates every CTOR shown.
    clicked: num(s?.numRecipientsClicked),
    revenue: parseMoney(s?.revenue),
    orders: num(s?.numOrders),
    // Kept so the currency can be read off the account's own formatting, and so a
    // parse can be eyeballed in the preview script.
    revenueRaw: typeof s?.revenue === "string" ? s.revenue : null,
  };
}

async function fetchSummary(base, cfg, c, budget) {
  budget?.check("Dotdigital summary");
  const json = await requestJSON(`${base}/v2/campaigns/${c.id}/summary`, {
    headers: authHeaders(cfg),
    label: `Dotdigital summary (${c.id})`,
    timeoutMs: 15000,
    retries: 1,
  });
  return toSend(c.id, c.name, json);
}

/** Sends for one brand's window, in lib/email.js's provider contract. */
export async function fetchDotdigitalEmail(env, brand, { start, end, deadline } = {}) {
  const cfg = dotdigitalConfig(env, brand);
  const missing = [];
  if (!cfg.user) missing.push(cfg.userName);
  if (!cfg.pass) missing.push(cfg.passName);
  if (missing.length) {
    throw new ApiError(
      "not-configured",
      `Dotdigital is not configured for brand "${brand}". Missing: ${missing.join(", ")}.`,
    );
  }
  if (cfg.region && !REGIONS.includes(cfg.region)) {
    throw new ApiError(
      "not-configured",
      `DOTDIGITAL_REGION must be one of ${REGIONS.join(", ")} — got "${cfg.region}".`,
    );
  }
  // The whole point of the guard: on a shared account, "no filter" means "every brand's
  // sends", which would be wrong under this brand's name and counted again in the
  // roll-ups. Refuse rather than duplicate.
  const mode = cfg.from.length ? "from" : cfg.books.length ? "books" : null;
  if (cfg.shared && !mode) {
    throw new ApiError(
      "not-configured",
      `This Dotdigital account serves more than one brand, so "${brand}" needs a filter ` +
        `of its own or it would show every brand's sends. Set ${cfg.fromName} to its ` +
        `from-address, or ${cfg.booksName} to its address book ids. ` +
        `Run \`npm run email-discover\` to list what this account offers.`,
    );
  }

  const info = await dotdigitalAccountInfo(cfg);
  const base = hostFor(info.region);
  const year = Number(String(end).slice(0, 4));
  // Keyed by ACCOUNT, not by brand: six brands share one account, so they share the
  // summary and address-book caches too and only the first of them pays for a campaign.
  const cacheKey = `ddg:sends:${info.id || cfg.user}:${year}`;

  const cached = await loadToken(cacheKey, env).catch(() => null);
  const byId = new Map(Object.entries(cached?.sends || {}));
  const bookIds = new Map(Object.entries(cached?.books || {}));

  const all = await listSentCampaigns(base, cfg, start, deadline);

  const failures = [];
  let ranOut = null;
  let dirty = false;

  // ── narrow the account's campaigns down to this brand's ────────────────────────────
  let mine = all;
  if (mode === "from") {
    // Free: the address rode along in the list, so nothing outside this brand ever
    // costs a call.
    mine = all.filter((c) => c.from && cfg.from.includes(c.from));
  } else if (mode === "books") {
    // Not free: a campaign's books are only knowable by asking, so the whole account
    // gets looked up once and cached forever.
    const unknown = all.filter((c) => !bookIds.has(c.id));
    if (unknown.length) {
      dirty = true;
      const got = await settledPool(
        unknown.map((c) => () => campaignAddressBooks(base, cfg, c.id, deadline)),
        CONCURRENCY,
      );
      got.forEach((r, i) => {
        if (r.status === "fulfilled") bookIds.set(unknown[i].id, r.value);
        else if (r.reason?.reason === "timeout") ranOut = ranOut || r.reason;
        else failures.push(unknown[i].id);
      });
    }
    const want = new Set(cfg.books);
    mine = all.filter((c) => (bookIds.get(c.id) || []).some((b) => want.has(b)));
  }

  // ── read the statistics for what is left ───────────────────────────────────────────
  // Re-read only what can still change: anything not cached, and any send inside the
  // freshness window. Everything older is final.
  const cutoff = daysAgo(FRESH_DAYS);
  const stale = ranOut
    ? []
    : mine.filter((c) => {
        const hit = byId.get(c.id);
        if (!hit || !hit.date) return true;
        return hit.date >= cutoff;
      });

  try {
    if (stale.length) {
      dirty = true;
      const results = await settledPool(
        stale.map((c) => () => fetchSummary(base, cfg, c, deadline)),
        CONCURRENCY,
      );
      results.forEach((r, i) => {
        if (r.status === "fulfilled") {
          if (r.value?.date) byId.set(stale[i].id, r.value);
          return;
        }
        // Running out of wall clock is the whole pull's problem; one campaign refusing
        // to report is that campaign's, and the rest of the window is still true.
        if (r.reason?.reason === "timeout") ranOut = ranOut || r.reason;
        else failures.push(stale[i].id);
      });
    }
  } finally {
    // Persist before rethrowing: whatever landed this time is work the next request —
    // and every other brand on this account — does not have to redo.
    if (dirty) {
      await saveToken(
        cacheKey,
        { sends: Object.fromEntries(byId), books: Object.fromEntries(bookIds), at: Date.now() },
        env,
      ).catch(() => {});
    }
  }
  if (ranOut) throw ranOut;

  const wanted = new Set(mine.map((c) => c.id));
  const sends = [...byId.values()].filter(
    (s) => wanted.has(String(s.id)) && s.date && s.date >= start && s.date <= end,
  );

  const currency = sends.map((s) => currencyFromMoney(s.revenueRaw)).find(Boolean) || null;

  const notes = [
    "Opens are unique opens and clicks are unique clickers (numTotalUniqueOpens / " +
      "numRecipientsClicked), so % Click and Click-to-Open are rates of people, not of clicks.",
  ];
  if (mode === "from") {
    notes.push(
      `${sends.length} of the account's ${all.length} sent campaigns matched ` +
        `${cfg.fromName} (${cfg.from.join(", ")}).`,
    );
  } else if (mode === "books") {
    notes.push(
      `${sends.length} of the account's ${all.length} sent campaigns matched ` +
        `${cfg.booksName} (address book ${cfg.books.join(", ")}).`,
    );
  } else {
    notes.push(
      "No brand filter is set, so this is every send in the account. That is correct " +
        "only while one brand uses it — see DOTDIGITAL_FROM_<STORE> in .env.example.",
    );
  }
  if (info.discovered) {
    notes.push(`Region ${info.region} was discovered from the account. Set DOTDIGITAL_REGION to pin it.`);
  }
  if (failures.length) {
    notes.push(
      `${failures.length} campaign${failures.length === 1 ? "" : "s"} did not answer and ` +
        `${failures.length === 1 ? "is" : "are"} absent from these totals ` +
        `(ids: ${failures.slice(0, 5).join(", ")}${failures.length > 5 ? "…" : ""}).`,
    );
  }

  return {
    currency,
    supports: { revenue: true }, // decided in api/email.js, across the whole window
    sends,
    notes,
    account: {
      // The brand filter, not the login, is what distinguishes two stores on one
      // account — so it is part of the identity the mapping check compares.
      id: `dotdigital:${info.id || cfg.user}${mode ? `#${mode}:${(mode === "from" ? cfg.from : cfg.books).join("+")}` : ""}`,
      label: `${cfg.userName} (${info.region})${mode ? ` · ${mode === "from" ? cfg.fromName : cfg.booksName}` : ""}`,
      shared: cfg.shared,
      filter: mode,
    },
    stats: { campaigns: all.length, matched: mine.length, fetched: stale.length, cached: byId.size },
  };
}
