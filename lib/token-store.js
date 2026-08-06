// lib/token-store.js
// Durable storage for ROTATING credentials.
//
// Why this exists: Shopify's client_credentials grant can be re-run any time from the
// permanent CLIENT_/SECRET_ pair (api/_token.js), so it needs no storage. Shopee and
// Lazada are different — each refresh INVALIDATES the refresh token and issues a new
// one. Env vars are read-only at runtime, so a rotated token has nowhere to live and the
// next refresh would fail with an expired token.
//
// Backends, in order of preference:
//   1. A Redis REST service (Upstash-compatible): TOKEN_STORE_URL + TOKEN_STORE_TOKEN.
//      This is the only backend that survives redeploys and multiple instances — set it
//      before relying on Shopee/Lazada in production.
//   2. The instance's temp directory — survives warm invocations on one instance only.
//   3. Process memory — survives nothing, but keeps a single request coherent.
//
// A value is an opaque JSON object; callers decide its shape. Nothing here is ever
// logged: these are live credentials.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const memory = new Map();
const DIR = join(tmpdir(), "iora-token-store");
const safe = (key) => String(key).replace(/[^A-Za-z0-9._:-]/g, "_");

function redisConfig(env = process.env) {
  const url = String(env.TOKEN_STORE_URL || "").trim().replace(/\/$/, "");
  const token = String(env.TOKEN_STORE_TOKEN || "").trim();
  return url && token ? { url, token } : null;
}

/** Which backend is in use — surfaced in `meta` so the deployment's durability is visible. */
export function tokenStoreKind(env = process.env) {
  return redisConfig(env) ? "redis" : "tmp";
}

export async function loadToken(key, env = process.env) {
  const k = safe(key);
  const redis = redisConfig(env);
  if (redis) {
    try {
      const res = await fetch(`${redis.url}/get/${encodeURIComponent(k)}`, {
        headers: { Authorization: `Bearer ${redis.token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const json = await res.json();
        if (json?.result) return JSON.parse(json.result);
      }
    } catch {
      // fall through to the local backends
    }
  }
  if (memory.has(k)) return memory.get(k);
  try {
    return JSON.parse(await readFile(join(DIR, `${k}.json`), "utf8"));
  } catch {
    return null;
  }
}

export async function saveToken(key, value, env = process.env) {
  const k = safe(key);
  memory.set(k, value);
  const body = JSON.stringify(value);
  const redis = redisConfig(env);
  if (redis) {
    try {
      const res = await fetch(`${redis.url}/set/${encodeURIComponent(k)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${redis.token}` },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return "redis";
    } catch {
      // fall through
    }
  }
  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(join(DIR, `${k}.json`), body, "utf8");
    return "tmp";
  } catch {
    return "memory";
  }
}

/** Test seam. */
export function clearTokenStoreMemory() {
  memory.clear();
}
