# Project Explainer: API Rate Limiter

## What This Project Is (in Simple Terms)

Imagine you have a public mailbox where anyone can drop a letter (like a contact form on a website). Without any rules, someone could spam the mailbox with thousands of letters, making it impossible for you to find the real messages. This project builds a smart "letter counter" for your website's contact form and other public endpoints. It counts how many requests (letters) each visitor sends in a given time and politely tells them to slow down if they're sending too many—like a courteous receptionist who says, "Please wait a moment before sending another letter."

In technical language: **we built a rate limiter** that protects your website from abuse (spam, bots, accidental overload) while remaining easy to understand and upgrade.

---

## Why We Built It

- **Protection**: Stops bots or overly enthusiastic users from flooding your contact form or API.
- **Fairness**: Ensures everyone gets a turn—no single user can monopolize your server's resources.
- **Learning**: Demonstrates core web‑security concepts (rate limiting, HTTP headers, middleware) in a hands‑on way.
- **Upgrade‑Ready**: Starts simple (in‑memory) so you can see how it works, then provides a clear path to a production‑ready Redis version when you need more power.

---

## How We Built It (the Pieces and Why)

| File / Folder | What It Is | Why We Made It / Design Reason |
|---------------|------------|--------------------------------|
| **src/lib/api-response.ts** | Helper functions (`ok`, `created`, `fail`) that shape all API replies in a consistent JSON format. | Keeps responses uniform so the rate‑limiting middleware and route handlers don’t repeat boilerplate. Makes error handling (like 429) straightforward. |
| **src/lib/api-errors.ts** | Error classes (e.g., `tooManyRequests`) that turn runtime problems into proper HTTP responses with correct status codes and optional headers. | Centralizes error creation—especially the 429 Too Many Requests response—so we don’t scatter status‑code logic everywhere. |
| **src/lib/rate-limit/types.ts** | TypeScript interfaces describing the contract: what a store must do (`increment`, `reset`), what config looks like, and what the limiter returns. | Provides a clear “plug‑in point”: any storage (memory, Redis, etc.) that follows this interface works with the same limiter logic. Makes swapping implementations safe and obvious. |
| **src/lib/rate-limit/memory-store.ts** | An in‑memory implementation of the store using a JavaScript `Map`. Tracks counts per key (e.g., `ping:1.2.3.4`) and automatically removes expired entries. | Chosen for development and learning: zero dependencies, instant visibility into how counters work, and simple to read. Includes lazy cleanup and a periodic sweep to prevent memory leaks (old entries piling up forever). |
| **src/lib/rate-limit/limiter.ts** | The core rate‑limiting logic that uses a store and a config (limit, window size) to decide if a request is allowed. Extracts the visitor IP from headers (`x-forwarded-for`). | Implements the **fixed‑window counter** algorithm: each request increments a counter for its time window; if the counter exceeds the limit, the request is blocked. The design is deliberately simple to teach the concept while being correct for low‑to‑moderate traffic. |
| **src/lib/rate-limit/config.ts** | A table of endpoint‑specific limits (e.g., `/api/ping` = 10 requests/minute, `/api/contact` = 3 requests/10 minutes) plus a default fallback. | Allows different routes to have different limits without changing the middleware. Shows how you might tune limits: a read‑only ping endpoint can be more liberal than a write‑heavy contact form. |
| **src/lib/rate-limit/index.ts** | A single export barrel that lets other code import `{ MemoryStore, RateLimiter, endpointConfig, … }` from one place. | Improves ergonomics—developers don’t need to remember deep paths; they just import from the rate‑limit “package”. |
| **src/app/api/ping/route.ts** | A tiny GET endpoint that replies `{ "message": "pong" }`. Assigned a limit of 10 requests per minute. | Serves as an easy‑to‑hit test case. You can rapidly call it with `curl` or a browser to see the rate limit in action. |
| **src/app/api/echo/route.ts** | A POST endpoint that echoes back the JSON you send it. Limited to 5 requests per minute. | Demonstrates rate limiting on a write‑type endpoint (where you might want stricter limits). |
| **src/app/api/contact/route.ts** | A mock contact‑form endpoint that validates name, email, and message, then pretends to send the message. Limited to 3 requests per 10 minutes. | Represents a realistic public‑facing form: low limit prevents spam bots while still allowing genuine users to reach out. Includes basic validation to reject garbage early (so spam doesn’t waste your rate‑limit quota). |
| **src/lib/utils.ts** | Small pure helpers (e.g., `validateEmail`) used by the contact route. | Keeps validation logic testable and isolated; shows where you’d plug in more sophisticated checks. |
| **src/middleware.ts** | The Next.js middleware that runs before every API route. It: <br>• Picks the right limit config for the endpoint <br>• Asks the limiter: “Should this request from this IP be allowed?” <br>• Adds rate‑limit headers to every response <br>• Returns a 429 with a helpful message if over limit <br>• Periodically cleans expired counters to avoid memory leaks. | Middleware is the ideal place for cross‑cutting concerns like rate limiting because it runs once for all `/api/*` paths, keeping the route handlers clean and focused on their business logic. |
| **docs/rate-limiting.md** | A detailed guide covering: how the limiter works, how to test it with `curl`, edge‑case explanations (IP trust, memory leaks, race conditions), and step‑by‑step instructions to swap the in‑memory store for a Redis‑based store using Upstash. | Serves as the living documentation for anyone (including future you) who wants to understand, operate, or upgrade the system. Explains not just “how” but also “why” each decision was made. |
| **Project-explainer.md** *(this file)* | A plain‑language overview of the whole project, its purpose, components, and rationale. | Provides a non‑technical entry point while still defining the technical terms and design intents for anyone who needs to dive deeper. |

---

## How It Works – Step by Step (Non‑Technical Analogy)

1. **Visitor arrives** at your site and submits the contact form (or hits `/api/ping`).
2. **Middleware intercepts** the request before it reaches your actual contact‑form code.
3. It looks up the visitor’s “address” (IP address, taken from a header that trusted proxies like Vercel set).
4. It builds a unique key like `contact:1.2.3.4` (endpoint + IP).
5. It asks the **memory store**: “How many times has this key been used in the last 10 minutes?”
6. If the count is **under the limit** (e.g., < 3 for contact), the request is **allowed** through, the store increments the counter, and you add helpful headers to the response:
   - `X-RateLimit-Limit: 3`
   - `X-RateLimit-Remaining: 2`
   - `X-RateLimit-Reset: <timestamp when the 10‑minute window starts over>`
7. If the count is **at or over the limit**, the middleware **stops** the request and returns a friendly `429 Too Many Requests` response, including:
   - A short message: “Rate limit exceeded. Try again in X seconds.”
   - A `Retry-After` header telling the visitor exactly how long to wait.
8. **Periodically**, a cleanup sweep removes old entries so the memory store doesn’t grow forever.

---

## What You Can Do With It Today

- **Run locally**: `npm run dev` then visit `http://localhost:3000` to see the homepage with example commands.
- **Test the limit**: Open a terminal and run:
  ```bash
  for i in {1..12}; do
    echo "Request $i:"
    curl -i http://localhost:3000/api/ping
  done
  ```
  You’ll see the first 10 requests succeed (200) and the 11th/12th return 429 with a “Try again in ~59s” message.
- **Test per‑IP isolation**: Add a fake IP header:
  ```bash
  curl -H "x-forwarded-for: 9.9.9.9" http://localhost:3000/api/ping
  curl -H "x-forwarded-for: 8.8.8.8" http://localhost:3000/api/ping
  ```
  Each IP gets its own counter.
- **Inspect headers**: Use `curl -i` to see the `X‑RateLimit‑*` and `Retry‑After` lines.

---

## How to Upgrade to Redis (When You Need More Power)

The in‑memory store works great for a single server (your laptop or a small VPS). If you ever deploy to a platform that runs multiple copies of your server (like Vercel serverless functions) or you need the counters to persist across restarts, switch to Redis:

1. **Install**: `npm install @upstash/redis`
2. **Create** `src/lib/rate-limit/redis-store.ts` (the template is in `docs/rate-limiting.md`).
3. **Update** `src/middleware.ts` to import and instantiate `RedisStore` with your Upstash URL and token (store them in environment variables).
4. **Deploy**—your rate limits will now be shared across all instances and survive restarts.

All the logic stays the same; only the storage layer changes.

---

## Why These Choices? (Design Intent Recap)

- **Fixed‑window counter** → easiest to grasp, sufficient for learning and low‑to‑moderate traffic; avoids complexity of sliding window or token bucket for a first pass.
- **Middleware approach** → keeps route handlers focused on their job (sending a contact email) and puts the “guardrail” in one place.
- **Header‑based IP** (`x-forwarded-for`) → works behind common proxies (Vercel, Cloudflare, NGINX); we documented the trust assumption so you know when to adjust.
- **Explicit configuration table** → makes limits visible and adjustable without digging into code.
- **Cleanup strategy** → lazy cleanup during each `increment` plus a periodic sweep prevents memory leaks while keeping the fast path simple.
- **Document‑first upgrade path** → you see exactly what changes are needed to move to Redis, demystifying the leap from dev to prod.

---

## Phase 1 Changes (August 27, 2026)

### What Was Added
We added **metrics and observability** so you can see the rate limiter working in real time:

| New File | What It Does |
|----------|--------------|
| `src/lib/rate-limit/metrics.ts` | **MetricsCollector** class — tracks total requests, allowed, blocked, active IPs (with 5-min TTL cleanup), requests/second (rolling 60s window), per-endpoint stats, and recent requests list. |
| `src/app/api/metrics/route.ts` | **GET /api/metrics** endpoint — returns JSON with all stats. Dashboard polls this. Also supports **POST /api/metrics** to reset for testing. |
| `src/middleware.ts` | Moved from project root to `src/` (Next.js requirement). Updated to call `metrics.recordRequest()` on every allowed/blocked request. Records IP, endpoint, status code, remaining tokens. |

### Design Decisions in Phase 1

1. **Separate metrics class** — Not embedded in middleware. Why?
   - Cleaner: middleware stays focused on rate limiting
   - Testable: mock the metrics collector easily
   - Upgradable: swap to Redis-backed metrics later without touching middleware

2. **TTL on IP tracking** — Active IPs expire after 5 minutes
   - Prevents memory leak from tracking forever-inactive visitors

3. **Rolling 60-second window** — Requests/second calculated over last 60 seconds
   - Shows current traffic intensity, not just total since server start

4. **Recent requests limited to 50** — Dashboard table doesn't grow infinitely

---

## Phase 2 Changes (August 27, 2026)

### What Was Added
We built a **live dashboard UI** to visualize rate limiting in real time:

| New File | What It Does |
|----------|--------------|
| `src/app/page.tsx` (replaced) | **Dashboard component** — client-side React component with live metrics visualization. Polls `/api/metrics` every 2 seconds. Shows: stat cards (total/allowed/blocked/IPs), requests/sec chart (line chart), per-endpoint breakdown table, blocked-vs-allowed bar chart, recent requests table (last 50), and testing instructions. |

### Design Decisions in Phase 2

1. **Client-side component (`use client`)** — Why?
   - Enables `useEffect` hook for polling metrics
   - Allows real-time state updates without server round-trips
   - Better UX: instant visual feedback

2. **Poll every 2 seconds** — Why not faster?
   - 2 seconds balances real-time feel with server load
   - Slower polling (10s) feels laggy; faster (500ms) wastes resources
   - Metrics endpoint is lightweight; server handles it easily

3. **Fail-open strategy** — If metrics endpoint unreachable:
   - Shows error message instead of crashing
   - User knows to check if dev server is running
   - Better than blank screen or error boundary fallback

4. **Recharts for charts** — Why?
   - Standard React charting library
   - Works seamlessly with Next.js 15
   - Small bundle, good performance
   - Built-in responsiveness

5. **Three visualization types**:
   - **Stat cards** — at-a-glance metrics (color-coded for quick scanning)
   - **Line chart** — requests/sec over time (spot traffic spikes)
   - **Bar chart** — blocked vs allowed per endpoint (identify abused endpoints)
   - **Tables** — detailed breakdown and recent requests (debug troubleshooting)

6. **WHY comments on every function/section** — Code explains not just *what* it does but *why* that design choice:
   - `StatCard` component reuses pattern (DRY)
   - `useEffect` polling with cleanup prevents memory leaks
   - Chart data slides window to last 30 points (prevents infinite growth)
   - Transforms metrics JSON into chart-friendly format

---

## Step-by-Step: How to Run and Test (Complete Guide)

### For Developers (Technical)

#### 1. Start the Server
```bash
cd API-limiter
npm install          # If first time
npm run dev          # Starts at localhost:3000 (or 3002/3003 if busy)
```

#### 2. Test Rate Limiting Works
```bash
# Test 1: Basic ping
curl http://localhost:3000/api/ping

# Test 2: Check rate limit headers
curl -i http://localhost:3000/api/ping

# Test 3: Hit the limit (11th request should fail)
for i in {1..11}; do curl -s http://localhost:3000/api/ping; done

# Test 4: Different IPs = separate counters
curl -H "x-forwarded-for: 1.2.3.4" http://localhost:3000/api/ping
curl -H "x-forwarded-for: 5.6.7.8" http://localhost:3000/api/ping
```

#### 3. Test Metrics (Phase 1)
```bash
# Check metrics (should be empty at start)
curl http://localhost:3000/api/metrics

# Make some requests
curl -s http://localhost:3000/api/ping > /dev/null
curl -s http://localhost:3000/api/ping > /dev/null

# Check metrics updated
curl http://localhost:3000/api/metrics | grep -E '"total"|"allowed"|"blocked"'

# Reset metrics for fresh test
curl -X POST http://localhost:3000/api/metrics
```

---

### For Non-Technical Users / Interview Demos

#### Prerequisite
You need a terminal (Command Prompt, PowerShell, or Terminal app).

#### The Demo Script
**Step 1: Start the app**
```bash
# In terminal, navigate to the project folder
cd [path-to]/API-limiter

# Start the server
npm run dev

# Keep this terminal open, it runs the web server
```

**Step 2: Show it works (open a SECOND terminal)**
```bash
# Make a request
curl http://localhost:3000/api/ping
```
→ You see: `{"success":true,"data":{"message":"pong"...}}`

**Step 3: Show rate limiting (THE COOL PART)**
```bash
# Make 11 requests fast
for i in {1..11}; do echo "Request $i:"; curl http://localhost:3000/api/ping; done
```
→ First 10 show: `{"success":true,...}`
→ The 11th shows: `{"success":false,"error":{"code":"RATE_LIMITED",...}}`

**Say to interviewer**: "Watch—the first 10 requests go through, but the 11th gets blocked. That's the rate limiter in action."

**Step 4: Show the metrics**
```bash
# Check live stats
curl http://localhost:3000/api/metrics
```
→ Shows: `"total":11,"allowed":10,"blocked":1,"activeIPs":1`

**Say**: "And here's the proof—10 allowed, 1 blocked, all tracked in real time."

**That's it!** You've demonstrated:
- ✅ Building a working API
- ✅ Implementing rate limiting algorithm
- ✅ Adding observability/metrics
- ✅ Clean code with good documentation

---

## Complete File Structure

```
API-limiter/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── ping/route.ts       # GET endpoint (10/min)
│   │   │   ├── echo/route.ts       # POST endpoint (5/min)
│   │   │   ├── contact/route.ts    # POST endpoint (3/10min)
│   │   │   └── metrics/route.ts    # GET stats, POST reset
│   │   ├── layout.tsx
│   │   └── page.tsx                # Homepage with instructions
│   └── lib/
│       ├── api-response.ts         # ok(), fail() helpers
│       ├── api-errors.ts           # tooManyRequests() etc
│       ├── utils.ts                # validateEmail()
│       └── rate-limit/
│           ├── types.ts            # Interfaces
│           ├── memory-store.ts     # In-memory counter
│           ├── limiter.ts          # Core algorithm
│           ├── config.ts           # Per-endpoint limits
│           ├── metrics.ts          # NEW: Stats collector
│           └── index.ts            # Exports
├── middleware.ts                   # Moved to root (Next.js requirement)
├── docs/
│   └── rate-limiting.md            # Technical docs
├── api limiter docs.txt            # Complete user guide (this file)
├── Project-explainer.md            # This file
├── package.json
├── tsconfig.json
└── next.config.js
```

---

## Git Commit

```bash
git add src/middleware.ts src/app/page.tsx src/lib/rate-limit/metrics.ts src/app/api/metrics/route.ts docs/rate-limiting.md
git commit -m "feat: add live dashboard UI with charts and metrics visualization

Phase 2 - dashboard for real-time rate limiter observability:
- Recharts for line/bar charts (requests/sec, blocked vs allowed)
- Stat cards: total/allowed/blocked/IPs/blocked%/req/sec
- Per-endpoint breakdown table + recent requests table
- Polls /api/metrics every 2s, fail-open on endpoint error
- WHY comments on every function explaining design decisions
- Updated all docs: Project-explainer.md, api limiter docs.txt"
```

---

## Errors Encountered & Fixed (2026-08-27)

We hit and solved several issues building this project. Full history is in `errors.md` (new file). Quick summary:

- **Middleware at wrong location** (`middleware.ts` at root instead of `src/`). Fixed: moved to `src/middleware.ts`.
- **Old server still running on port 3005** (PID 6424). Fixed: kill old process, restart fresh.
- **Metrics always zero** — caused by middleware not running / old server instance. Fixed by fixing both above.
- **`grep` dependency accidentally added** — removed with `npm uninstall grep`.
- **Dashboard not updating** — old server serving old `page.tsx`. Fixed by restart.

**Approach behind fixes:** We document every error with root cause + fix + WHY. The `errors.md` file preserves this for future maintainers. All fixes verified with `curl -i` to confirm 429 + headers + metrics.

---

## What's Next (Roadmap)

- **Phase 2**: Dashboard UI with live charts (Recharts)
- **Phase 3**: Simulator page — click "Send 100 requests" and watch them become 429
- **Phase 4**: Redis upgrade for distributed rate limiting
- **Phase 5**: Unit tests

---

**In short**: You now have a complete, well‑documented rate limiter you can run, test, understand, and upgrade—all while learning foundational web‑backend patterns. The project balances simplicity (so you can see each moving part) with realism (production‑ready patterns like middleware, clean error handling, and a documented upgrade path). Feel free to read the source files, run the tests, and extend it as your needs grow. Happy building! 🚀