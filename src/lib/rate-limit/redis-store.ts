/**
 * Redis / Upstash store. Same consume() contract as MemoryStore.
 * Only constructed when UPSTASH_REDIS_REST_URL and TOKEN are set.
 */

import { Redis } from "@upstash/redis";
import {
  ConsumeResult,
  RateLimitConfig,
  RateLimitStore,
} from "./types";

interface FixedState {
  kind: "fixed";
  count: number;
  resetTime: number;
}

interface TokenState {
  kind: "token";
  tokens: number;
  lastRefill: number;
}

interface SlidingState {
  kind: "sliding";
  timestamps: number[];
}

type State = FixedState | TokenState | SlidingState;

export class RedisStore implements RateLimitStore {
  private redis: Redis;

  constructor(url: string, token: string) {
    this.redis = new Redis({ url, token });
  }

  async increment(
    key: string,
    windowMs: number
  ): Promise<{ count: number; resetTime: number }> {
    const result = await this.consume(key, {
      windowMs,
      limit: Number.MAX_SAFE_INTEGER,
    });
    return { count: result.count, resetTime: result.resetTime };
  }

  async consume(key: string, config: RateLimitConfig): Promise<ConsumeResult> {
    const algorithm = config.algorithm ?? "fixed-window";
    const redisKey = `rl:${algorithm}:${key}`;
    if (algorithm === "token-bucket") {
      return this.consumeToken(redisKey, config);
    }
    if (algorithm === "sliding-window") {
      return this.consumeSliding(redisKey, config);
    }
    return this.consumeFixed(redisKey, config);
  }

  private async read(redisKey: string): Promise<State | null> {
    const raw = await this.redis.get<State | string>(redisKey);
    if (!raw) return null;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) as State;
      } catch {
        return null;
      }
    }
    return raw;
  }

  private async write(redisKey: string, state: State, ttlMs: number): Promise<void> {
    await this.redis.set(redisKey, state, { px: Math.max(1000, ttlMs) });
  }

  private async consumeFixed(
    redisKey: string,
    config: RateLimitConfig
  ): Promise<ConsumeResult> {
    const now = Date.now();
    const windowMs = config.windowMs;
    const limit = config.limit;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const resetTime = windowStart + windowMs;
    const existing = await this.read(redisKey);
    let count = 1;
    let usedReset = resetTime;
    if (existing && existing.kind === "fixed" && existing.resetTime > now) {
      count = existing.count + 1;
      usedReset = existing.resetTime;
    }
    await this.write(
      redisKey,
      { kind: "fixed", count, resetTime: usedReset },
      usedReset - now
    );
    return {
      allowed: count <= limit,
      count,
      remaining: Math.max(0, limit - count),
      resetTime: usedReset,
      limit,
    };
  }

  private async consumeToken(
    redisKey: string,
    config: RateLimitConfig
  ): Promise<ConsumeResult> {
    const now = Date.now();
    const capacity = config.limit;
    const refillPerSec =
      config.refillRate ?? capacity / Math.max(0.001, config.windowMs / 1000);
    const existing = await this.read(redisKey);
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
      refillPerSec > 0
        ? Math.ceil((tokensUntilOne / refillPerSec) * 1000)
        : config.windowMs;
    const resetTime =
      now + (allowed ? Math.ceil((1 / refillPerSec) * 1000) : msUntilToken);
    await this.write(
      redisKey,
      { kind: "token", tokens, lastRefill },
      Math.max(config.windowMs * 2, 60_000)
    );
    return {
      allowed,
      count: Math.ceil(capacity - tokens),
      remaining: Math.max(0, Math.floor(tokens)),
      resetTime,
      limit: capacity,
    };
  }

  private async consumeSliding(
    redisKey: string,
    config: RateLimitConfig
  ): Promise<ConsumeResult> {
    const now = Date.now();
    const windowMs = config.windowMs;
    const limit = config.limit;
    const cutoff = now - windowMs;
    const existing = await this.read(redisKey);
    let timestamps =
      existing && existing.kind === "sliding"
        ? existing.timestamps.filter((t) => t > cutoff)
        : [];
    if (timestamps.length >= limit) {
      const oldest = timestamps[0] ?? now;
      await this.write(
        redisKey,
        { kind: "sliding", timestamps },
        windowMs
      );
      return {
        allowed: false,
        count: timestamps.length,
        remaining: 0,
        resetTime: oldest + windowMs,
        limit,
      };
    }
    timestamps = [...timestamps, now];
    const oldest = timestamps[0] ?? now;
    await this.write(redisKey, { kind: "sliding", timestamps }, windowMs);
    return {
      allowed: true,
      count: timestamps.length,
      remaining: Math.max(0, limit - timestamps.length),
      resetTime: oldest + windowMs,
      limit,
    };
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(
      `rl:fixed-window:${key}`,
      `rl:token-bucket:${key}`,
      `rl:sliding-window:${key}`
    );
  }
}

export function tryCreateRedisStore(): RedisStore | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new RedisStore(url, token);
}
