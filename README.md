# Ecom Dashboard

**One dashboard. Eight platforms. No made-up numbers.**

A live performance dashboard for a multi-brand fashion retailer operating eight Shopify Plus
storefronts across Singapore and Malaysia. It pulls revenue, funnel, traffic, discount,
fulfilment, ad-spend, email and marketplace data straight from first-party APIs — and renders an
honest blank wherever a source genuinely cannot answer.

### What it connects to

| Source                                 | What it feeds                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shopify (ShopifyQL + Orders + GraphQL) | Revenue, orders, AOV, sessions, conversion, funnel, best sellers, traffic attribution, discount performance, pick-up vs delivery, sale vs full-price mix |
| Meta Marketing API                     | Facebook ad spend, impressions, clicks, purchases                                                                                                        |
| Google Ads API                         | Google campaign spend and conversions                                                                                                                    |
| TikTok Business API                    | TikTok campaign performance                                                                                                                              |
| Dotdigital (Marketing API v2)          | Email sends, unique opens, unique clickers, attributed revenue and orders — iORA, SANS & SANS, TRT                                                       |
| Klaviyo (Reporting API)                | The same, for MONOLOQ SG                                                                                                                                 |
| Shopee Open Platform                   | Marketplace orders and voucher performance                                                                                                               |
| Lazada Open Platform                   | Marketplace orders and voucher performance                                                                                                               |

### How it is built

- **One serverless function per source** on Vercel. The browser only ever calls our own `/api/*` endpoints — no credential ever reaches client-side JavaScript.
- **Per-section failure.** Each panel carries its own `meta` state, so a throttled ShopifyQL query or a missing ad account degrades one card instead of the page.
- **Honest data contract.** Unattributable → `null` → "—". Failed ≠ zero. Unconfigured → an empty state naming the exact environment variables to set. No estimates, ever.
- **Deliberate cost control.** Orders paged at 250, compare-at-price lookups batched under a wall-clock budget, complete payloads edge-cached ~5 minutes while transient failures are never cached.

### Engineering notes worth reading

The Shopee and Lazada clients both handle **rotating refresh tokens** — each marketplace
invalidates the old token on every refresh, and serverless environment variables are read-only
at runtime, so the rotated pair is persisted to a Redis-compatible token store rather than
lost on redeploy.

Meta ad accounts are **discovered, but mapped by hand**. A Business-Manager system-user
token sees nothing on `/me/adaccounts` — `me` is the system user, which owns no assets — so
`npm run meta-accounts` reads the business's `owned_ad_accounts` and `client_ad_accounts`
edges instead, follows paging, and dedupes. What it will not do is feed those ids into the
live pull: which `act_` id belongs to which brand stays an explicit `META_AD_ACCOUNT_<STORE>`
mapping, so that renaming an account in Ads Manager cannot re-attribute its spend and a
newly created account cannot appear in a rollup nobody chose to put it in. The script exists
to reconcile the two — it flags an active account mapped to no brand, an account wired to
two, an env var pointing at an account the token cannot see, and a brand mixing SGD with
MYR, and exits non-zero on anything that would misreport.

Email is **two providers behind one panel**, and they fail in opposite directions.
Dotdigital has no bulk report — statistics are one GET per campaign, and iORA SG alone
sends ~60 a month — so a cold year is ~700 calls that fit neither a 60s function nor a
polite call rate. Klaviyo has the bulk report but a 2-per-minute ceiling on it. So the
Dotdigital client caches summaries in the token store keyed by account and year, re-reads
only sends inside a 30-day freshness window (an older send can never change again), and
persists partial progress even when it runs out of budget, so a cold cache converges over
a couple of refreshes instead of restarting from nothing; the Klaviyo client makes exactly
one grouped report call per pull and leans on the edge cache to keep it there.

The Dotdigital account is **shared, so the credential cannot be the attribution**. All
six Dotdigital brands sit in one account — one login sees every brand's campaigns, and
nothing in the API tags a send with a brand. Handing that list to each brand would show
iORA's sends under SANS and have SGALL/GROUP total the same campaign several times. So
the split is an explicit id mapping, with two ways to draw it because one account can be
organised either way: a campaign's **from-address**, which is free (it already rides
along in the campaign list, so a brand's pull never spends a call on another brand's
campaign), or its **address books**, which cost one lookup per campaign in the whole
account — you cannot know a campaign is not yours without looking — cached permanently
afterwards since a sent campaign's books never change. Per store, the from-address wins
where both are set, so a brand whose SG and MY share one sender splits on books while its
siblings split on address.

Klaviyo is the opposite case. The Group holds one Klaviyo account and it serves **MONOLOQ
SG alone** — SG sender, SGD, `Asia/Singapore`, no MY audience in any send. There the key
*is* the attribution, so it is scoped per store as `KLAVIYO_API_KEY_MONOSG`; a bare
`KLAVIYO_API_KEY` would also resolve for MONOMY and report SG's sends twice over, once
under each store and twice again inside MYALL and GROUP. MONOMY reads `not-configured`
until MONOLOQ MY has an account of its own. The audience-based split (`KLAVIYO_LIST_*`)
stays supported for the day one account does serve both, but it could not rescue this
one: its audiences are lifecycle segments (`RFM - Champions`, `ALL CUSTOMER`), not
markets.

Klaviyo reports `send_time` in UTC while its own UI and its report bucketing use the
account's timezone, so send dates are converted before use — otherwise an evening send is
dated to the day before, and at a year boundary it lands in the wrong fiscal year.

Splitting on campaign *name* is deliberately unsupported: "IORA RED PACKET" is one rename
away from not matching, and a rename must never re-attribute revenue — the same rule that
keeps ad accounts mapped by `act_` id.

Setting any filter variable is itself the declaration that the account is shared; from
then on a configured store without one is `not-configured` rather than a silent duplicate
of the whole account, so there is no separate switch to forget. `npm run email-discover`
lists the account's from-addresses, address books and Klaviyo audiences with send counts
so the mapping is written from ids; `npm run preview-email` then sweeps all eight brands
and exits non-zero if two ended up on the same one, or on a currency that does not match
the store's.

Neither platform exposes a "commerce tracking is connected" flag, and an account without
it returns 0 revenue and 0 orders for every send. That is indistinguishable per-campaign
from a send that genuinely sold nothing, so it is judged across the whole window: where
nothing at all was attributed, revenue and orders are null for every row and the Revenue,
Orders and AOV lines read "—" with a note saying why. A year of campaigns reported as
earning exactly $0 would be a lie about the campaigns rather than about the tracking.

The ad clients each normalise to one `{currency, supports, rows, notes}` shape, and where a
platform has no unambiguous metric — TikTok purchase value, or Google "conversions" meaning
every action the account counts — the panel says so in plain language instead of quietly
presenting a number that means something else.
