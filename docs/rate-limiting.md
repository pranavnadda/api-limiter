/**
 * README — Rate Limiting Documentation
 *
 * WHY: This explains how the rate limiter works, how to test it,
 * and how to upgrade to Redis for production use.
 */

## How It Works

### Core Algorithm
- **Fixed-window counter**: Each request increments a counter for its window.
- **Window**: 60,000ms (10 minutes) by default, configurable per endpoint.
- **Per-IP tracking**: Uses x-forwarded-for header to isolate clients.

### Rate Limit Headers
Every response includes:
- `X-RateLimit-Limit`: Max requests allowed in the window
- `X-RateLimit-Remaining`: Requests remaining in the current window
- `X-RateLimit-Reset`: Unix timestamp when window resets
- `Retry-After`: Seconds to wait (only on 429 responses)

### Edge Cases

**1. x-forwarded-for Trust**
- Only trust this header if your server is behind a proxy (Vercel, Cloudflare, etc.)
- For raw self-hosted servers, consider using `req.ip` (Next.js 14+) or require API keys
- See [`security-IP-spoof.md`](./security-IP-spoof.md) for the full design note (added in Phase 3 audit, 2026-08-28)

**2. Memory Leak Prevention**
- Expired entries are lazily cleaned during increment()
- Periodic cleanup runs every 5 minutes to remove all expired buckets

**3. Clock Skew**
- Uses Date.now() consistently — no external time sources
- All calculations are based on the same clock

**3. Concurrent Requests**
- JavaScript is single-threaded, so requests execute sequentially
- No true race conditions in the Map-based store
- Second request always sees the latest state

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