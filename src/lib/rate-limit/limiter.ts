/**
 * Rate Limiter Core — Fixed-Window Algorithm
 *
 * WHY: Fixed-window is easiest to reason about. Each request counts
 * against the window it falls into. Simple, predictable, and sufficient
 * for most portfolio projects.
 *
 * EDGE CASE HANDLED — Window alignment:
 * We align windows to Unix epoch (now / windowMs * windowMs) rather
 * than request time. This prevents requests at window boundaries from
 * sliding the window forward unexpectedly.
 *
 * EDGE CASE HANDLED — Concurrent requests:
 * Because JavaScript is single-threaded, concurrent requests to the
 * same endpoint execute sequentially. We don't need atomic increment
 * operations (like Redis INCR). The second request always sees the first.
 */

import { RateLimitStore, RateLimitConfig, RateLimitResult } from "./types";

export interface RateLimitRequestContext {
  url: string;
  method: string;
  headers: Headers;
}

export class RateLimiter {
  private store: RateLimitStore;

  constructor(store: RateLimitStore) {
    this.store = store;
  }

  /**
   * Check if a request should be allowed through.
   *
   * WHY: We separate the limit check from the middleware so the same
   * logic can be used in middleware, API routes, or server actions.
   *
   * @param req - The request being checked
   * @param config - Rate limit config for this endpoint
   * @param keyPrefix - Optional prefix for key isolation (e.g., "contact")
   */
  async check(
    req: RateLimitRequestContext,
    config: RateLimitConfig,
    keyPrefix?: string
  ): Promise<RateLimitResult> {
    const ip = this.extractIP(req.headers);
    const endpoint = keyPrefix || req.url.split("?")[0].split("/").pop() || "default";
    const key = `${endpoint}:${ip}`;

    const result = await this.store.increment(key, config.windowMs);
    const allowed = result.count <= config.limit;

    return {
      success: allowed,
      limit: config.limit,
      remaining: Math.max(0, config.limit - result.count),
      resetTime: result.resetTime,
    };
  }

  /**
   * Extract IP from request headers.
   *
   * WHY: x-forwarded-for is set by proxies (Vercel, nginx, Cloudflare).
   * It contains the client's original IP followed by proxy IPs.
   * We take the first address (the client).
   *
   * EDGE CASE — Trusted proxy required:
   * x-forwarded-for can be spoofed if a client connects directly
   * to the server (without a proxy). Only trust this header when
   * your server is behind a known proxy (Vercel does this; raw VPS doesn't).
   */
  private extractIP(headers: Headers): string {
    const forwarded = headers.get("x-forwarded-for");
    if (forwarded) {
      return forwarded.split(",")[0]?.trim() || "unknown";
    }
    // Fallback for direct connections or missing proxy headers
    return "unknown";
  }
}
