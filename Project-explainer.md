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

## Next Steps / Ideas for Further Exploration

- Add a **sliding window** or **token bucket** algorithm for smoother limiting.
- Build a tiny **dashboard** that shows current counts per endpoint/IP.
- Write automated tests (Jest + supertest) that assert the limiter behaves correctly under concurrency.
- Integrate with a real email service (e.g., Resend, SendGrid) for the contact route.
- Add API‑key authentication alongside rate limiting for truly private endpoints.
- Create a visual example (using the `dataviz` skill) that shows how request counts fill and drain over time.

---

**In short**: You now have a complete, well‑documented rate limiter you can run, test, understand, and upgrade—all while learning foundational web‑backend patterns. The project balances simplicity (so you can see each moving part) with realism (production‑ready patterns like middleware, clean error handling, and a documented upgrade path). Feel free to read the source files, run the tests, and extend it as your needs grow. Happy building! 🚀