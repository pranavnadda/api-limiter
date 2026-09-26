/**
 * Rate limiting — current behavior
 *
 * The sections below the "Historical notes" heading describe earlier milestones.
 * Where they disagree with this section, this section is the one that matches the code.
 */

## Current behavior

- **Algorithms:** fixed-window, token-bucket, and sliding-window. Extra windows are AND-ed: if any window would deny, none of them are consumed.
- **Primary window:** `60_000` ms is one minute. Contact is `600_000` ms (10 minutes) at 3 requests.
- **Identity:** an API key counts only when it is in `API_KEYS`. Otherwise the key is the trusted client IP. `TRUSTED_PROXY_HOPS` reads that many addresses from the right of `x-forwarded-for`. Missing identity returns `400 CLIENT_IP_REQUIRED` and does not share an `unknown` bucket.
- **Redis:** fixed windows commit with `INCR` and `PEXPIRE` inside one `EVAL`. Token bucket, sliding window, and multi-window checks are the same script, so a deny writes nothing. Bans and live config are stored in Redis when Upstash is configured. A store error returns `503`, not the next handler.
- **Reset header:** `X-RateLimit-Reset` is epoch milliseconds. `Retry-After` is delta seconds. The `429` body puts `retryAfter` on `error.details`.
- **Admin:** `ADMIN_RESET_KEY` is required. There is no default key. Reads of config, metrics, SSE, and Prometheus use the same check. The dashboard posts the key once and then sends an httpOnly cookie.

## Historical notes

## How It Works

### Core Algorithm
- **Fixed-window counter**: Each request increments a counter for its window.
- **Window**: 60,000 ms is one minute. Per-endpoint values live in `src/lib/rate-limit/config.ts`.
- **Identity**: Issued API key, otherwise the trusted proxy IP. See [`security-IP-spoof.md`](./security-IP-spoof.md).

### Rate Limit Headers
Every response includes:
- `X-RateLimit-Limit`: Max requests allowed in the window
- `X-RateLimit-Remaining`: Requests remaining in the current window
- `X-RateLimit-Reset`: Epoch milliseconds when the window resets
- `Retry-After`: Seconds to wait (only on 429 responses)

### Edge Cases

**1. Trusted proxy hops**
- `TRUSTED_PROXY_HOPS=0` ignores forwarding headers.
- A positive hop count takes that many addresses from the right of `x-forwarded-for`.
- See [`security-IP-spoof.md`](./security-IP-spoof.md).

**2. Memory cleanup**
- Fixed-window, token-bucket, and sliding-window entries are swept on a timer, not on the request path.
- Token buckets expire after `max(windowMs * 2, 60s)` of idle time.

**3. Clock**
- Uses `Date.now()` consistently.

**4. Concurrent requests**
- One Node process runs JavaScript turns one at a time, and `consumeAll` does not yield between the check and the commit.
- Across processes, Redis `EVAL` runs `INCR` / `PEXPIRE` (and the token and sliding updates) as one script so two instances cannot both read the same count and both allow.

### Testing the Rate Limiter

### Manual Testing with curl

### Basic Test (ping endpoint)
```bash
# Make 11 requests quickly
for i in {1..11}; do
  curl -i http://localhost:3000/api/ping
done

# 11th request should return 429
```

### Per-IP Isolation Test
```bash
# Test with different IPs (simulate different clients)
curl -H "x-forwarded-for: 1.2.3.4" http://localhost:3000/api/ping
curl -H "x-forwarded-for: 5.6.7.8" http://localhost:3000/api/ping

# Each IP should have separate counters
```

### Header Verification
```bash
curl -i http://localhost:3000/api/ping
# Look for:
# X-RateLimit-Limit: 10
# X-RateLimit-Remaining: 9
# X-RateLimit-Reset: 1712345678901
```

### 429 Response Example
```bash
# When rate limit exceeded
curl -i http://localhost:3000/api/ping

# Response includes:
# HTTP/1.1 429 Too Many Requests
# X-RateLimit-Limit: 10
# X-RateLimit-Remaining: 0
# X-RateLimit-Reset: 1712345678901
# Retry-After: 60
```

## Upgrading to Redis

### When to Upgrade
- You need distributed rate limiting (multiple server instances)
- You're deploying to Vercel or other serverless platforms
- You need persistence across restarts

### Setup Steps

1. **Install Upstash Redis**
   ```bash
   npm install @upstash/redis
   ```

2. **Create Redis Instance**
   - Go to https://upstash.com/
   - Create a new Redis instance (free tier available)
   - Get your REST URL and API token

3. **Create Redis Store**
   ```ts
   // src/lib/rate-limit/redis-store.ts
   import { Redis } from "@upstash/redis";

   export class RedisStore implements RateLimitStore {
     private store: Redis;
     
     constructor(redisUrl: string, apiToken: string) {
       this.store = new Redis(redisUrl, {
         fetchOptions: { headers: { Authorization: `Bearer ${apiToken}` } },
       });
     }
     
     async increment(key: string, windowMs: number) {
       const now = Math.floor(Date.now() / windowMs) * windowMs;
       const resetTime = now + windowMs;
       
       // Use Redis INCR with TTL
       const count = await this.store.incr(key);
       await this.store.pexpire(key, windowMs);
       
       return { count, resetTime };
     }
     
     async reset(key: string): Promise<void> {
       await this.store.del(key);
     }
   }
   ```

4. **Update middleware.ts**
   ```ts
   // Replace MemoryStore with RedisStore
   import { RedisStore } from "./redis-store";
   
   // In middleware:
   const store = new RedisStore(process.env.REDIS_URL!, process.env.REDIS_TOKEN!);
   ```

5. **Environment Variables**
   - Add to .env.local:
     ```
     REDIS_URL=your-upstash-url
     REDIS_TOKEN=your-upstash-token
   ```

## Phase 1: Metrics Implementation (Completed 2026-08-27)

### What Was Added
- `src/lib/rate-limit/metrics.ts`: Metrics collector tracking total, allowed, blocked, active IPs (with TTL cleanup), requests/sec (rolling 60s window), per-endpoint stats, and recent requests.
- `src/app/api/metrics/route.ts`: Endpoint exposing live metrics; includes POST reset for testing.
- Updated middleware: Records metrics for every allowed/blocked request with IP and endpoint tracking.
- Moved `middleware.ts` to project root (Next.js requires this).

### Why This Design
- Separate metrics class (not embedded in middleware) = clean separation, easy testing, future Redis metrics upgrade.
- TTL on IP tracking (5 min) + rolling window (1 min) = no memory leaks.
- Metrics endpoint = dashboard can poll in real-time.

### Verification
- `GET /api/metrics` returns `{total, allowed, blocked, activeIPs, requestsPerSecond, endpoints, recentRequests}`
- Metrics start at zero, increment correctly after requests, show blocked requests after rate limit hits.

## Phase 2: Dashboard UI (Completed 2026-08-27)

### What Was Added
- `src/app/page.tsx` (replaced): Live dashboard with stats cards, line chart (requests/sec), bar chart (blocked vs allowed per endpoint), per-endpoint table, recent requests table.
- Uses Recharts for visualization, polls `/api/metrics` every 2 seconds.
- Fail-open: shows error message if metrics endpoint unreachable.

### Why This Design
- Client-side component (`use client`) enables useEffect for polling.
- 2-second poll interval balances real-time feel with server load.
- Recharts: standard React library, works with Next.js 15.
- Three chart types cover different observability needs (at-a-glance, trends, comparisons).
- WHY comments on every function/section.

---

## Phase 3 (Next): Live Simulator

- `src/lib/rate-limit/` — Rate limiting core
  - `types.ts` — Interfaces and types
  - `memory-store.ts` — In-memory implementation
  - `redis-store.ts` — Redis implementation (optional)
  - `limiter.ts` — Core logic
  - `config.ts` — Endpoint-specific configurations
  - `index.ts` — Public API export

- `src/app/api/` — Test API routes
  - `/ping` — GET (10/min)
  - `/echo` — POST (5/min)
  - `/contact` — POST (3/10min)

- `src/middleware.ts` — Applies rate limiting to all API routes

## Success Criteria

✅ Understand how rate limiting algorithms work (fixed-window)
✅ See clean abstraction patterns (interface → multiple implementations)
✅ Learn Next.js middleware integration
✅ Practice API route design
✅ Understand HTTP headers and response codes

## Limitations

- **In-memory only**: Not suitable for multi-server deployments
- **x-forwarded-for trust**: Requires proxy setup for accurate IP tracking
- **No persistence**: Counters reset on server restart (expected for dev)
- **Basic validation**: Email regex is simple — enhance for production

## Future Improvements

- Add sliding window algorithm for smoother rate limiting
- Implement token bucket algorithm for more realistic usage patterns
- Add metrics dashboard for monitoring rate limit usage
- Create a test suite with Jest and supertest