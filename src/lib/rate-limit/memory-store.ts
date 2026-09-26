/**
 * Memory Store — fixed-window, token-bucket, and sliding-window.
 *
 * `now` is injectable so the algorithm comparison can advance time without waiting.
 * consumeAll probes every window and commits all of them, or commits none.
 */

import {
  CommitResult,
  ConsumeResult,
  RateLimitConfig,
  RateLimitStore,
  WindowCheck,
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
  idleTtlMs: number;
}

interface SlidingBucket {
  kind: "sliding";
  timestamps: number[];
  windowMs: number;
}

type Bucket = FixedBucket | TokenBucket | SlidingBucket;

function cloneBucket(bucket: Bucket): Bucket {
  if (bucket.kind === "sliding") {
    return { kind: "sliding", timestamps: [...bucket.timestamps], windowMs: bucket.windowMs };
  }
  return { ...bucket };
}

export function tokenIdleTtlMs(windowMs: number): number {
  return Math.max(windowMs * 2, 60_000);
}

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

  async probe(key: string, config: RateLimitConfig): Promise<ConsumeResult> {
    return this.probeSync(key, config);
  }

  async consume(key: string, config: RateLimitConfig): Promise<ConsumeResult> {
    return this.consumeSync(key, config);
  }

  async consumeAll(checks: WindowCheck[]): Promise<CommitResult> {
    const snapshot = new Map<string, Bucket | null>();
    for (const check of checks) {
      if (snapshot.has(check.key)) continue;
      const existing = this.store.get(check.key);
      snapshot.set(check.key, existing ? cloneBucket(existing) : null);
    }

    const results: ConsumeResult[] = [];
    let allowed = true;
    for (const check of checks) {
      const result = this.consumeSync(check.key, check.config);
      results.push(result);
      if (!result.allowed) {
        allowed = false;
        break;
      }
    }

    if (!allowed) {
      for (const [key, bucket] of snapshot) {
        if (bucket) this.store.set(key, bucket);
        else this.store.delete(key);
      }
      return {
        allowed: false,
        results: checks.map((check) => this.probeSync(check.key, check.config)),
      };
    }

    return { allowed: true, results };
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
      } else if (bucket.kind === "token") {
        const idle = bucket.idleTtlMs ?? 60_000;
        if (now - bucket.lastRefill > idle) {
          this.store.delete(key);
          removed++;
        }
      } else if (bucket.kind === "sliding") {
        const windowMs = bucket.windowMs ?? 60_000;
        bucket.timestamps = bucket.timestamps.filter((t) => t > now - windowMs);
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

  private probeSync(key: string, config: RateLimitConfig): ConsumeResult {
    const algorithm = config.algorithm ?? "fixed-window";
    if (algorithm === "token-bucket") return this.previewToken(key, config).result;
    if (algorithm === "sliding-window") return this.previewSliding(key, config).result;
    return this.previewFixed(key, config).result;
  }

  private consumeSync(key: string, config: RateLimitConfig): ConsumeResult {
    const algorithm = config.algorithm ?? "fixed-window";
    if (algorithm === "token-bucket") {
      const preview = this.previewToken(key, config);
      if (preview.next) this.store.set(key, preview.next);
      return preview.result;
    }
    if (algorithm === "sliding-window") {
      const preview = this.previewSliding(key, config);
      if (preview.next) this.store.set(key, preview.next);
      return preview.result;
    }
    const preview = this.previewFixed(key, config);
    if (preview.next) this.store.set(key, preview.next);
    return preview.result;
  }

  private previewFixed(
    key: string,
    config: RateLimitConfig
  ): { result: ConsumeResult; next: FixedBucket | null } {
    const now = this.now();
    const windowMs = config.windowMs;
    const limit = config.limit;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const resetTime = windowStart + windowMs;
    const existing = this.store.get(key);
    const current =
      existing && existing.kind === "fixed" && existing.resetTime > now ? existing : null;
    const count = current ? current.count : 0;
    const nextCount = count + 1;
    const allowed = nextCount <= limit;
    const usedReset = current?.resetTime ?? resetTime;
    return {
      next: allowed ? { kind: "fixed", count: nextCount, resetTime: usedReset } : null,
      result: {
        allowed,
        count: allowed ? nextCount : count,
        remaining: allowed ? Math.max(0, limit - nextCount) : 0,
        resetTime: usedReset,
        limit,
      },
    };
  }

  private previewToken(
    key: string,
    config: RateLimitConfig
  ): { result: ConsumeResult; next: TokenBucket | null } {
    const now = this.now();
    const capacity = config.limit;
    const refillPerSec =
      config.refillRate ?? capacity / Math.max(0.001, config.windowMs / 1000);
    const existing = this.store.get(key);
    let tokens = capacity;
    let lastRefill = now;
    if (existing && existing.kind === "token") {
      const elapsedSec = Math.max(0, (now - existing.lastRefill) / 1000);
      tokens = Math.min(capacity, existing.tokens + elapsedSec * refillPerSec);
      lastRefill = now;
    }
    const allowed = tokens >= 1;
    if (allowed) tokens -= 1;
    const tokensUntilOne = allowed ? 0 : Math.max(0, 1 - tokens);
    const msUntilToken =
      refillPerSec > 0 ? Math.ceil((tokensUntilOne / refillPerSec) * 1000) : config.windowMs;
    const resetTime =
      now +
      (allowed
        ? refillPerSec > 0
          ? Math.ceil((1 / refillPerSec) * 1000)
          : config.windowMs
        : msUntilToken);
    return {
      next: allowed
        ? { kind: "token", tokens, lastRefill, idleTtlMs: tokenIdleTtlMs(config.windowMs) }
        : null,
      result: {
        allowed,
        count: Math.ceil(capacity - tokens),
        remaining: Math.max(0, Math.floor(tokens)),
        resetTime,
        limit: capacity,
      },
    };
  }

  private previewSliding(
    key: string,
    config: RateLimitConfig
  ): { result: ConsumeResult; next: SlidingBucket | null } {
    const now = this.now();
    const windowMs = config.windowMs;
    const limit = config.limit;
    const cutoff = now - windowMs;
    const existing = this.store.get(key);
    const timestamps =
      existing && existing.kind === "sliding"
        ? existing.timestamps.filter((t) => t > cutoff)
        : [];
    if (timestamps.length >= limit) {
      const oldest = timestamps[0] ?? now;
      return {
        next: null,
        result: {
          allowed: false,
          count: timestamps.length,
          remaining: 0,
          resetTime: oldest + windowMs,
          limit,
        },
      };
    }
    const nextTimestamps = [...timestamps, now];
    const oldest = nextTimestamps[0] ?? now;
    return {
      next: { kind: "sliding", timestamps: nextTimestamps, windowMs },
      result: {
        allowed: true,
        count: nextTimestamps.length,
        remaining: Math.max(0, limit - nextTimestamps.length),
        resetTime: oldest + windowMs,
        limit,
      },
    };
  }
}
