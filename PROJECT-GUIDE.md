# API Rate Limiter — Three-Level Guide

Last updated: 2026-09-26

Click-by-click use of the dashboard: [docs/use-guide.md](docs/use-guide.md). How to run and deploy it: [docs/deployment-guide.md](docs/deployment-guide.md).

This file explains the whole project in three levels:

1. **Non-technical** — what it is and what a visitor sees
2. **Technical** — how the code is structured and how a request flows
3. **Tools, reasons, errors, and fixes** — what we used, why, what broke, and how it was fixed

Run it with `npm run dev` and open `http://localhost:3000`. Shorter run notes live in [README.md](README.md).

---

## Level 1 — Non-technical POV

Think of a public mailbox (a contact form or any open API). Without rules, one person can stuff it with thousands of letters and nobody else gets through. This project is a polite counter at the door:

- Each visitor gets a limited number of requests in a time window (for example 10 pings per minute).
- If they go over, the app says “please wait” (`429 Too Many Requests`) and tells them when to retry.
- Different doors can have different rules: a health-check ping is looser than a contact form.
- A live board on the homepage shows how many requests were allowed, how many were blocked, and the last few events.

You do not need a terminal to demo it. The **simulator** on the dashboard fires a burst of requests for you. Changing limits, lists, or the board requires the admin key set in `ADMIN_RESET_KEY`. There is no built-in demo password. You can also compare algorithms and reset the numbers on the board.

**What it is not:** a full firewall, login product, or paid API gateway. It is a small, understandable rate limiter you can run, watch, and explain.

---

## Level 2 — Technical POV

### What sits where (the tree)

```
API-limiter/
├── src/
│   ├── middleware.ts                 # Guard: every /api/* request hits this first
│   ├── app/
│   │   ├── page.tsx                  # Dashboard (simulator, charts, live limits)
│   │   ├── layout.tsx / globals.css  # Shell, fonts, dark theme
│   │   └── api/
│   │       ├── ping / echo / contact # Demo endpoints the limiter protects
│   │       ├── metrics               # JSON snapshot + reset
│   │       ├── metrics/stream        # Server-Sent Events for the dashboard
│   │       ├── metrics/prometheus    # OpenMetrics text for scrapers
│   │       ├── config                # Live limit / allow / block lists
│   │       └── compare               # Isolated algorithm burst (does not touch live counters)
│   └── lib/
│       ├── api-response.ts / api-errors.ts
│       ├── admin-auth.ts             # Shared X-Admin-Reset check
│       └── rate-limit/
│           ├── types.ts              # Store + config contracts
│           ├── identity.ts           # IP vs API key
│           ├── config.ts             # Default per-endpoint table
│           ├── config-store.ts       # Mutable copy the dashboard edits
│           ├── memory-store.ts       # In-process counters (default)
│           ├── redis-store.ts        # Optional Upstash implementation
│           ├── limiter.ts            # Algorithm dispatch + multi-window AND
│           ├── ban-store.ts          # Extra cooldown after repeated 429s
│           ├── metrics.ts            # Totals, audit, SSE subscribers
│           ├── compare.ts            # Fake-clock comparison
│           └── index.ts              # Public exports
├── test/memory-store.test.ts
├── docs/                             # Rate-limit + IP-spoof notes
├── Dockerfile / docker-compose.yml
└── next.config.js                    # Node middleware runtime
```

### Request path

```
Browser / curl
    → Next.js middleware (Node runtime)
        → no issued key and no trusted IP? 400
        → blocklist? 403
        → allowlist? skip limit
        → temp-banned? 429
        → RateLimiter.check (probe every window, consume all or none)
            → MemoryStore or Redis EVAL
               (fixed-window | token-bucket | sliding-window)
        → record the limiter decision (allowed rows are not stored as HTTP 200)
        → next() + X-RateLimit-*  or  429 + Retry-After
        → store error? 503
    → route handler only runs if allowed
Dashboard ← admin cookie, then SSE /api/metrics/stream
```

**Identity:** an issued `X-API-Key` or `Authorization: Bearer` (the value must be in `API_KEYS`); otherwise the trusted client IP. `TRUSTED_PROXY_HOPS` reads from the right of `x-forwarded-for`. Hop count 0 ignores forwarding headers.

**Why middleware:** one guard for all APIs. A blocked request never reaches `ping` / `contact`.

**Why Node runtime, not Edge:** middleware and route handlers must share the same in-memory singletons (`MemoryStore`, `metrics`). Edge is a separate isolate; that split made metrics always look empty until we opted into Node middleware.

**Fail closed:** if consume, the ban check, or a config load throws, the middleware returns `503`. Unset Redis variables are not an error; that path uses the in-memory store.

---

## Level 3 — What was used, why, errors, and fixes

### What was used and why

| Piece | Why |
|---|---|
| **Next.js 15 App Router** | API routes, middleware, and the dashboard in one app. |
| **TypeScript** | `RateLimitStore` / `RateLimitConfig` make Redis and extra algorithms a swap, not a rewrite. |
| **Fixed-window counter** | Easiest correct algorithm; windows aligned to the Unix epoch. |
| **Token bucket** | Smooth refill; answers “why not burst at the window edge?” |
| **Sliding window** | Counts the last N ms, not the current bucket. |
| **In-memory `Map` (`MemoryStore`)** | Zero infra for local demo. Lazy + periodic cleanup. |
| **`globalThis` singletons** | Survive Next.js hot reload; one store and one metrics collector per process. |
| **`experimental.nodeMiddleware` + `runtime: "nodejs"`** | Same process as `/api/metrics`, so the dashboard reads real counts. |
| **React + Recharts** | Live board: poll or SSE, charts, simulator. |
| **IBM Plex (via `next/font`)** | Dashboard type. Operate-mode UI, not a landing-page costume. |
| **Vitest** | Fast unit tests for store, limiter, identity, bans, metrics. |
| **`@upstash/redis` (optional)** | Only if env vars are set. No account is required to run locally. **No real Redis credentials were used.** |
| **`ADMIN_RESET_KEY`** | Required for every admin read and write. There is no default. A missing key rejects Connect, including the old string `demo-reset-key`. |
| **SSE + Prometheus** | Dashboard stream + a scrape format for ops-style demos. |
| **Docker Compose** | One-command run without a local Node install. |
| **Not used** | Weighted/cost-based limits (explicitly excluded). No JWT product, captcha, or WAF. |

### Errors that occurred and how they were fixed

The full log is [errors.md](errors.md). The important ones, in human terms:

**Middleware in the wrong folder**  
Next.js with a `src/` app only loads `src/middleware.ts`. A file at the repo root never ran, so nothing was ever rate-limited and metrics stayed at zero. **Fix:** put middleware under `src/`.

**Two servers, two memories**  
An old `npm run dev` on another port had its own counters. New code could not see them. **Fix:** kill the old process; one process = one store.

**Metrics recorded in the wrong place (or with fake numbers)**  
`/api/ping` used to pretend every request was allowed with 10 remaining. Blocked requests never reached the route, so they were invisible. **Fix:** record in middleware for both 200 and 429.

**The real “metrics always zero” bug (Edge vs Node)**  
Even after recording in middleware, Next.js still ran middleware in **Edge** and `/api/metrics` in **Node**. Two copies of the `metrics` object. Restarts “fixed” nothing. **Fix:** Node middleware + pin singletons on `globalThis`. Verified with live non-zero JSON.

**Rate-limit headers missing on success**  
Docs promised `X-RateLimit-*` on every response. The allowed path set headers on the *incoming request* (`NextResponse.next({ request: { headers } })`), which clients never see. **Fix:** set them on the *outgoing* `NextResponse`.

**Spoofable IP (`x-forwarded-for`)**  
A client who can hit the origin can pick any IP and get a fresh quota. **Fix:** documented in `docs/security-IP-spoof.md`, and later **API keys** as an identity that is not the IP. Full “trusted proxy only” is deployment-specific.

**Open metrics reset**  
Anyone could `POST /api/metrics` and wipe the board. **Fix:** require `X-Admin-Reset`.

**No tests / dirty git**  
No runner; `.next/` was committable. **Fix:** Vitest + a real `.gitignore`.

**Docs pointed at a Redis file that did not exist**  
Later **fixed** by adding `src/lib/rate-limit/redis-store.ts` (still unused unless Upstash env vars are set).

**Operational noise**  
Per-request `console.log` in middleware, leftover docs for a `?clear=true` reset that never existed. **Fix:** removed; warn if the admin env key is unset.

### What was *not* a credential leak

- Redis env vars were never filled. Local runs use memory.
- `demo-reset-key` is not accepted. Admin access exists only when `ADMIN_RESET_KEY` is set to a value you choose.

### Still accepted on purpose

- Email regex is basic.
- Admin auth is a shared header, not a user system.
- In-memory counters do not survive multiple serverless isolates (use Redis there).
- Weighted costs (ping costs 1, contact costs 5) were never added.
