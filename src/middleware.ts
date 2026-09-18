/**
 * Next.js Middleware — Rate Limiting
 *
 * WHY: Middleware runs before the route handler, making it the ideal
 * place to enforce rate limits globally across all API routes.
 *
 * EDGE CASES HANDLED HERE:
 * - Skip non-API routes (only protect /api/*)
 * - Per-endpoint config (contact gets different limits than ping)
 * - Graceful degradation: if limiter fails, allow request
 *   (fail-open, not fail-closed — better for user experience)
 * - Proper rate limit headers on every response
 */

import { NextResponse, NextRequest } from "next/server";
import { MemoryStore } from "@/lib/rate-limit/memory-store";
import { RateLimiter } from "@/lib/rate-limit/limiter";
import { endpointConfig, defaultConfig } from "@/lib/rate-limit/config";
import { tooManyRequests } from "@/lib/api-errors";
import { metrics } from "@/lib/rate-limit/metrics";

// Singleton store — persists across requests within the same process.
// WHY globalThis: survives dev hot-reloads so counters aren't reset on edit.
declare global {
  // eslint-disable-next-line no-var
  var __rateLimitStore: MemoryStore | undefined;
}
const store =
  globalThis.__rateLimitStore ??
  (globalThis.__rateLimitStore = new MemoryStore());
const limiter = new RateLimiter(store);

// Periodic cleanup of expired entries (every 5 minutes)
// WHY: Prevents memory leaks in long-running processes
const CLEANUP_INTERVAL = 5 * 60 * 1000;
let lastCleanup = 0;

/**
 * Extract the endpoint name from the URL path.
 * e.g., /api/ping -> "ping", /api/contact -> "contact"
 */
function getEndpointKey(req: NextRequest): string | null {
  const url = req.nextUrl.pathname;
  if (!url.startsWith("/api/")) return null;

  // Remove /api/ prefix and get the route segment
  const path = url.replace("/api/", "");
  const segments = path.split("/");
  return segments[0] || null;
}

/**
 * Extract the client IP from request headers with proper fallback chain.
 * WHY: x-forwarded-for is set by trusted proxies (Vercel, Cloudflare, nginx).
 * x-real-ip is a common alternative header. Without these, all clients
 * look identical and per-IP isolation breaks locally.
 */
function extractClientIP(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }
  return "unknown";
}

export async function middleware(req: NextRequest) {
  const endpoint = getEndpointKey(req);
  if (!endpoint) {
    return NextResponse.next();
  }

  // Select config: endpoint-specific or default
  const config = endpointConfig[endpoint] || defaultConfig;

  // Extract IP early so it's available for both the limiter and metrics
  const ip = extractClientIP(req);

  // Run periodic cleanup
  const now = Date.now();
  if (now - lastCleanup > CLEANUP_INTERVAL) {
    store.cleanupExpired();
    lastCleanup = now;
  }

  try {
    const result = await limiter.check(
      {
        url: req.nextUrl.pathname,
        method: req.method,
        headers: req.headers,
        ip,
      },
      config,
      endpoint
    );

    // Rate limit headers applied to the RESPONSE (what the client sees).
    // WHY: These must be set on the outgoing response, not on the forwarded
    // request headers. NextResponse.next({ request: { headers } }) only
    // rewrites the request sent downstream, so the client would never see them.
    const rateLimitHeaders: Record<string, string> = {
      "X-RateLimit-Limit": String(result.limit),
      "X-RateLimit-Remaining": String(result.remaining),
      "X-RateLimit-Reset": String(result.resetTime),
    };

    if (!result.success) {
      // Rate limit exceeded — respond with 429
      const retryAfter = Math.ceil((result.resetTime - now) / 1000);

      // Record the blocked request in metrics.
      // WHY: This is the single source of truth for the dashboard.
      // Doing it in middleware (not the route) means blocked requests
      // are counted even though the route handler never runs.
      metrics.recordRequest(endpoint, false, ip, 429, 0);

      const err = tooManyRequests(
        `Rate limit exceeded. Try again in ${retryAfter}s.`,
        retryAfter
      );

      // Return a structured JSON response with the error
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: "RATE_LIMITED",
            message: err.message,
            retryAfter,
          },
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            ...rateLimitHeaders,
            "Retry-After": String(retryAfter),
          },
        }
      );
    }

    // Record the allowed request in metrics.
    // WHY: See comment above. This runs after the limit check passes.
    metrics.recordRequest(endpoint, true, ip, 200, result.remaining);

    const res = NextResponse.next();
    for (const [name, value] of Object.entries(rateLimitHeaders)) {
      res.headers.set(name, value);
    }
    return res;
  } catch (err) {
    // Fail-open: if the limiter crashes, let the request through
    // WHY: Better to serve a few extra requests than break the app
    console.error("[Middleware] Rate limiter error:", err);
    return NextResponse.next();
  }
}

export const config = {
  matcher: ["/api/:path*"],
  // WHY: Node.js runtime (not Edge) so the middleware shares the same
  // in-memory MemoryStore and metrics collector singletons as the Node
  // route handlers (e.g. /api/metrics). Requires experimental.nodeMiddleware
  // in next.config.js.
  runtime: "nodejs",
};
