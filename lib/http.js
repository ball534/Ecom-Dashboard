// lib/http.js
// Shared, dependency-free HTTP helper for the NON-Shopify sources (ad platforms and
// marketplaces). Shopify has its own client (api/_shopify.js) because it speaks one
// GraphQL endpoint with its own cost-throttle semantics; everything else is plain REST,
// so it shares this.
//
// The contract mirrors api/_error.js on purpose: one error type carrying a coarse
// `reason` the endpoints can put straight into `meta.sections.<key>.reason`, so the
// front-end reads ONE shape no matter which source failed.

export class ApiError extends Error {
  constructor(reason, message, status) {
    super(message || reason);
    this.name = "ApiError";
    // not-configured | auth | scope | throttle | http | timeout | api | error
    this.reason = reason;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Map an HTTP status onto a reason. 401/403 is a credential/permission problem (a
// retry cannot fix it); 429 and 5xx are transient (a retry can).
function reasonForStatus(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "throttle";
  return "http";
}

/**
 * Fetch JSON with a timeout and a bounded backoff on transient failures.
 *
 * Options:
 *   method, headers, body   — as fetch
 *   query                   — object appended as a query string (undefined/null skipped)
 *   timeoutMs               — per attempt (default 20s)
 *   retries                 — extra attempts after a transient failure (default 2)
 *   label                   — used in error messages, e.g. "Meta insights"
 *   accept                  — a function(parsedJson, res) that throws ApiError for
 *                             API-level errors carried inside a 200 body (TikTok,
 *                             Lazada and Shopee all do this).
 *
 * Never returns a partial/failed result: it either resolves with the parsed body or
 * throws ApiError. Callers turn that into a null section plus a reason — never a zero.
 */
export async function requestJSON(url, opts = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    query,
    timeoutMs = 20000,
    retries = 2,
    label = "request",
    accept,
  } = opts;

  let target = url;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) target += (target.includes("?") ? "&" : "?") + s;
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(700 * 2 ** (attempt - 1));
    let res;
    try {
      res = await fetch(target, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      lastErr = new ApiError(
        timedOut ? "timeout" : "http",
        timedOut
          ? `${label}: timed out after ${timeoutMs}ms`
          : `${label}: network error — ${e?.message || e}`,
      );
      continue; // both are transient — retry
    }

    const text = await res.text().catch(() => "");
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    if (!res.ok) {
      const reason = reasonForStatus(res.status);
      const detail = apiMessage(json) || text.slice(0, 300);
      const err = new ApiError(
        reason,
        `${label}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
        res.status,
      );
      // Only transient statuses are worth another attempt.
      if (reason === "auth" || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
        throw err;
      }
      lastErr = err;
      continue;
    }

    if (json === null && text) {
      throw new ApiError("api", `${label}: response was not JSON — ${text.slice(0, 200)}`);
    }
    if (accept) {
      // `accept` throws ApiError for an API-level error inside a 200 body. A throttle
      // reported that way is still worth retrying.
      try {
        accept(json, res);
      } catch (e) {
        if (e instanceof ApiError && e.reason === "throttle" && attempt < retries) {
          lastErr = e;
          continue;
        }
        throw e;
      }
    }
    return json;
  }
  throw lastErr || new ApiError("error", `${label}: failed`);
}

// Best-effort extraction of a provider's own error text, for diagnosable messages.
function apiMessage(json) {
  if (!json || typeof json !== "object") return "";
  const e = json.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    return String(e.message || e.error_user_msg || e.details || JSON.stringify(e)).slice(0, 300);
  }
  if (json.message) return String(json.message).slice(0, 300);
  return "";
}

/**
 * Run thunks with limited concurrency, returning Promise.allSettled-shaped results.
 * Same helper shape api/insights.js uses for the ShopifyQL fan-out: one slow or failing
 * source must never take the others down with it.
 */
export async function settledPool(thunks, width = 3) {
  const results = new Array(thunks.length);
  let next = 0;
  async function worker() {
    while (next < thunks.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await thunks[i]() };
      } catch (e) {
        results[i] = { status: "rejected", reason: e };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, thunks.length) }, worker));
  return results;
}

/** Per-source failure record for `meta`, identical in shape to the Shopify endpoints'. */
export const failInfo = (e) => ({
  ok: false,
  reason: e && e.reason ? e.reason : "error",
  message: String(e?.message || e).slice(0, 400),
});

/**
 * A wall-clock budget for a multi-page pull. Serverless functions have a hard ceiling
 * (60s on Vercel's Hobby plan), and a marketplace year can be thousands of orders. A
 * pull that runs out of budget must FAIL — a partially paged month would silently
 * understate revenue, which is worse than a blank.
 */
export function deadline(ms) {
  const end = Date.now() + ms;
  return {
    remaining: () => end - Date.now(),
    expired: () => Date.now() >= end,
    check(label) {
      if (Date.now() >= end) {
        throw new ApiError("timeout", `${label}: exceeded its ${Math.round(ms / 1000)}s budget`);
      }
    },
  };
}
