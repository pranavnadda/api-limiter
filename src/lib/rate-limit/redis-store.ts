/**
 * Redis / Upstash store. consumeAll is one EVAL: INCR + PEXPIRE for fixed
 * windows, and a single commit for token-bucket and sliding-window.
 * A multi-window deny writes nothing.
 */

import type { ConsumeSpec } from "./atomic";
import { getRedis, type RedisLike } from "./redis-client";
import { CONSUME_ALL_LUA } from "./scripts";
import {
  CommitResult,
  ConsumeResult,
  RateLimitConfig,
  RateLimitStore,
  WindowCheck,
} from "./types";
import { tokenIdleTtlMs } from "./memory-store";

export function counterKey(algorithm: string, logicalKey: string): string {
  return `rl:${algorithm}:${logicalKey}`;
}

function buildSpec(config: RateLimitConfig, now: number): ConsumeSpec {
  const algorithm = config.algorithm ?? "fixed-window";
  const windowMs = config.windowMs;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetTime = windowStart + windowMs;
  const refillRate =
    config.refillRate ?? config.limit / Math.max(0.001, windowMs / 1000);
  return {
    algorithm,
    limit: config.limit,
    windowMs,
    refillRate,
    ttlMs: Math.max(1, resetTime - now),
    resetTime,
    idleTtlMs: tokenIdleTtlMs(windowMs),
  };
}

function parseCommit(raw: unknown): CommitResult {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  return value as CommitResult;
}

export class RedisStore implements RateLimitStore {
  constructor(private readonly redis: RedisLike) {}

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

  async probe(key: string, config: RateLimitConfig): Promise<ConsumeResult> {
    const commit = await this.evaluate([{ key, config }], true);
    return commit.results[0];
  }

  async consume(key: string, config: RateLimitConfig): Promise<ConsumeResult> {
    const commit = await this.consumeAll([{ key, config }]);
    return commit.results[0];
  }

  async consumeAll(checks: WindowCheck[]): Promise<CommitResult> {
    return this.evaluate(checks, false);
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(
      counterKey("fixed-window", key),
      counterKey("token-bucket", key),
      counterKey("sliding-window", key)
    );
  }

  private async evaluate(checks: WindowCheck[], dry: boolean): Promise<CommitResult> {
    if (checks.length === 0) return { allowed: true, results: [] };
    const now = Date.now();
    const keys = checks.map((check) =>
      counterKey(check.config.algorithm ?? "fixed-window", check.key)
    );
    const specs = checks.map((check) => buildSpec(check.config, now));
    const raw = await this.redis.eval(CONSUME_ALL_LUA, keys, [
      String(now),
      JSON.stringify(specs),
      dry ? "1" : "0",
    ]);
    return parseCommit(raw);
  }
}

export function tryCreateRedisStore(): RedisStore | null {
  const redis = getRedis();
  if (!redis) return null;
  return new RedisStore(redis);
}
