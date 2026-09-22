/**
 * Memory Store — fixed-window, token-bucket, and sliding-window.
 *
 * `now` is injectable so the algorithm comparison can advance time without waiting.
 */

import {
  ConsumeResult,
  RateLimitConfig,
  RateLimitStore,
} from "./types";

interface FixedBucket {
  kind: "fixed";
  count: number;
  resetTime: number;
}

interface TokenBucket {
  kind: "token";
  tokens: number;
  lastRefill: number;
}

interface SlidingBucket {
  kind: "sliding";
  timestamps: number[];
}

type Bucket = FixedBucket | TokenBucket | SlidingBucket;

export class MemoryStore implements RateLimitStore {
  private store = new Map<string, Bucket>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async increment(
    key: string,
    windowMs: number
  ): Promise<{ count: number; resetTime: number }> {
    const result = await this.consume(key, { windowMs, limit: Number.MAX_SAFE_INTEGER });
    return { count: result.count, resetTime: result.resetTime };
  }

  async consume(key: string, config: RateLimitConfig): Promise<ConsumeResult> {
    const algorithm = config.algorithm ?? "fixed-window";
    if (algorithm === "token-bucket") return this.consumeTokenBucket(key, config);
    if (algorithm === "sliding-window") return this.consumeSlidingWindow(key, config);
    return this.consumeFixedWindow(key, config);
  }

  private consumeFixedWindow(
    key: string,
    config: RateLimitConfig
  ): ConsumeResult {
    const now = this.now();
    const windowMs = config.windowMs;
    const limit = config.limit;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const resetTime = windowStart + windowMs;

    const existing = this.store.get(key);
    if (existing && existing.kind === "fixed" && existing.resetTime <= now) {
      this.store.delete(key);
    }

    const current = this.store.get(key);
    if (current && current.kind === "fixed") {
      current.count += 1;
      return {
        allowed: current.count <= limit,
        count: current.count,
        remaining: Math.max(0, limit - current.count),
        resetTime: current.resetTime,
        limit,
      };
    }

    this.store.set(key, { kind: "fixed", count: 1, resetTime });
    return {
      allowed: 1 <= limit,
      count: 1,
      remaining: Math.max(0, limit - 1),
      resetTime,
      limit,
    };
  }

  private consumeTokenBucket(
    key: string,
    config: RateLimitConfig
  ): ConsumeResult {
    const now = this.now();
    const capacity = config.limit;
    const refillPerSec =
      config.refillRate ?? capacity / Math.max(0.001, config.windowMs / 1000);

    let bucket = this.store.get(key);
    if (!bucket || bucket.kind !== "token") {
      bucket = { kind: "token", tokens: capacity, lastRefill: now };
      this.store.set(key, bucket);
    }

    const elapsedSec = Math.max(0, (now - bucket.lastRefill) / 1000);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
    bucket.lastRefill = now;

    const allowed = bucket.tokens >= 1;
    if (allowed) {
      bucket.tokens -= 1;
    }

    const tokensUntilOne = allowed ? 0 : Math.max(0, 1 - bucket.tokens);
    const msUntilToken =
      refillPerSec > 0 ? Math.ceil((tokensUntilOne / refillPerSec) * 1000) : config.windowMs;
    const resetTime = now + (allowed ? Math.ceil((1 / refillPerSec) * 1000) : msUntilToken);

    return {
      allowed,
      count: Math.ceil(capacity - bucket.tokens),
      remaining: Math.max(0, Math.floor(bucket.tokens)),
      resetTime,
      limit: capacity,
    };
  }

  private consumeSlidingWindow(
    key: string,
    config: RateLimitConfig
  ): ConsumeResult {
    const now = this.now();
    const windowMs = config.windowMs;
    const limit = config.limit;
    const cutoff = now - windowMs;

    let bucket = this.store.get(key);
    if (!bucket || bucket.kind !== "sliding") {
      bucket = { kind: "sliding", timestamps: [] };
      this.store.set(key, bucket);
    }

    bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);

    if (bucket.timestamps.length >= limit) {
      const oldest = bucket.timestamps[0] ?? now;
      return {
        allowed: false,
        count: bucket.timestamps.length,
        remaining: 0,
        resetTime: oldest + windowMs,
        limit,
      };
    }

    bucket.timestamps.push(now);
    const oldest = bucket.timestamps[0] ?? now;
    return {
      allowed: true,
      count: bucket.timestamps.length,
      remaining: Math.max(0, limit - bucket.timestamps.length),
      resetTime: oldest + windowMs,
      limit,
    };
  }

  async reset(key: string): Promise<void> {
    this.store.delete(key);
  }

  cleanupExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, bucket] of this.store.entries()) {
      if (bucket.kind === "fixed" && bucket.resetTime <= now) {
        this.store.delete(key);
        removed++;
      } else if (bucket.kind === "sliding") {
        bucket.timestamps = bucket.timestamps.filter((t) => t > now - 24 * 60 * 60 * 1000);
        if (bucket.timestamps.length === 0) {
          this.store.delete(key);
          removed++;
        }
      }
    }
    return removed;
  }

  getCount(key: string): number | undefined {
    const bucket = this.store.get(key);
    if (!bucket) return undefined;
    if (bucket.kind === "fixed") return bucket.count;
    if (bucket.kind === "token") return Math.ceil(bucket.tokens);
    return bucket.timestamps.length;
  }
}
