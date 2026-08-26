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

// Singleton store — persists across requests within the same process
const store = new MemoryStore();
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

export async function middleware(req: NextRequest) {
  const endpoint = getEndpointKey(req);
  if (!endpoint) {
    return NextResponse.next();
  }

  // Select config: endpoint-specific or default
  const config = endpointConfig[endpoint] || defaultConfig;

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
      },
      config,
      endpoint
    );

    // Build response with rate limit headers
    const headers = new Headers(req.headers);
    headers.set("X-RateLimit-Limit", String(result.limit));
    headers.set("X-RateLimit-Remaining", String(result.remaining));
    headers.set("X-RateLimit-Reset", String(result.resetTime));

    if (!result.success) {
      // Rate limit exceeded — respond with 429
      headers.set("Retry-After", String(Math.ceil((result.resetTime - now) / 1000)));

      const err = tooManyRequests(
        `Rate limit exceeded. Try again in ${Math.ceil((result.resetTime - now) / 1000)}s.`,
        Math.ceil((result.resetTime - now) / 1000)
      );

      // Return a structured JSON response with the error
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: "RATE_LIMITED",
            message: err.message,
            retryAfter: Math.ceil((result.resetTime - now) / 1000),
          },
        }),
        {
          status: 429,
          headers,
        }
      );
    }

    return NextResponse.next({
      request: {
        headers,
      },
    });
  } catch (err) {
    // Fail-open: if the limiter crashes, let the request through
    // WHY: Better to serve a few extra requests than break the app
    console.error("[Middleware] Rate limiter error:", err);
    return NextResponse.next();
  }
}

export const config = {
  matcher: ["/api/:path*"],
};
