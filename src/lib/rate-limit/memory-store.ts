/**
 * Memory Store — In-Memory Rate Limit Storage
 *
 * WHY: This provides a fast, zero-dependency rate limiter for development
 * and single-server deployments. No Redis/Upstash needed initially.
 *
 * EDGE CASES HANDLED:
 * - Race conditions: We use a single-threaded event loop and synchronous
 *   Map operations (JavaScript is single-threaded, so concurrent writes
 *   to the same key within the same tick can't corrupt the Map)
 * - Memory leaks: Expired entries are cleaned during increment() using
 *   lazy cleanup (only scan when accessing that bucket, not on every call)
 * - Clock skew: All times use Date.now() consistently; no dependency on
 *   external time sources
 *
 * UPGRADE PATH: Replace with RedisStore when you need distributed
 * rate limiting across multiple server instances (Vercel serverless, etc.)
 */

import { RateLimitStore } from "./types";

interface Bucket {
  count: number;
  resetTime: number;
}

export class MemoryStore implements RateLimitStore {
  private store = new Map<string, Bucket>();

  /**
   * Increment the counter for a key and return current state.
   *
   * WHY: Fixed-window counter is simple to understand. We track
   * how many requests occurred in the current time window.
   *
   * RACE CONDITION NOTE: Because JavaScript runs on a single event loop,
   * there is no true concurrent access between different requests.
   * If two requests hit at exactly the same millisecond, they execute
   * sequentially, not in parallel. The second read sees the first write.
   */
  async increment(
    key: string,
    windowMs: number
  ): Promise<{ count: number; resetTime: number }> {
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const resetTime = windowStart + windowMs;

    // Lazy cleanup: only remove expired entries when we access them
    const existing = this.store.get(key);
    if (existing && existing.resetTime <= now) {
      this.store.delete(key);
    }

    if (this.store.has(key)) {
      const bucket = this.store.get(key)!;
      bucket.count += 1;
      return { count: bucket.count, resetTime: bucket.resetTime };
    }

    this.store.set(key, { count: 1, resetTime });
    return { count: 1, resetTime };
  }

  /**
   * Reset the counter for a key.
   *
   * WHY: Allows manual reset (e.g., after a user contacts support,
   * or during testing).
   */
  async reset(key: string): Promise<void> {
    this.store.delete(key);
  }

  /**
   * Cleanup all expired entries.
   *
   * WHY: Prevents unbounded memory growth. Call periodically
   * (e.g., every 5 minutes via a timer, or when memory reaches threshold).
   */
  cleanupExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, bucket] of this.store.entries()) {
      if (bucket.resetTime <= now) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Get current count for debugging/monitoring.
   */
  getCount(key: string): number | undefined {
    return this.store.get(key)?.count;
  }
}
