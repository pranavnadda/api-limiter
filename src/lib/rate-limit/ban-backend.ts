import { BanStore, banStore } from "./ban-store";
import { getRedis, type RedisLike } from "./redis-client";
import { BAN_STRIKE_LUA } from "./scripts";

export interface BanBackend {
  isBanned(key: string, now?: number): Promise<number | null>;
  recordStrike(
    key: string,
    threshold: number,
    strikeWindowMs: number,
    banMs: number,
    now?: number
  ): Promise<number | null>;
  clear(key?: string): Promise<void>;
  cleanupExpired(now?: number): void;
}

export function strikeKey(identity: string): string {
  return `rl:strike:${identity}`;
}

export function banKey(identity: string): string {
  return `rl:ban:${identity}`;
}

export class MemoryBanBackend implements BanBackend {
  constructor(private readonly inner: BanStore) {}

  async isBanned(key: string, now = Date.now()): Promise<number | null> {
    return this.inner.isBanned(key, now);
  }

  async recordStrike(
    key: string,
    threshold: number,
    strikeWindowMs: number,
    banMs: number,
    now = Date.now()
  ): Promise<number | null> {
    return this.inner.recordStrike(key, threshold, strikeWindowMs, banMs, now);
  }

  async clear(key?: string): Promise<void> {
    this.inner.clear(key);
  }

  cleanupExpired(now?: number): void {
    this.inner.cleanupExpired(now);
  }
}

export class RedisBanStore implements BanBackend {
  constructor(private readonly redis: RedisLike) {}

  async isBanned(key: string, now = Date.now()): Promise<number | null> {
    const raw = await this.redis.get(banKey(key));
    if (!raw) return null;
    const until = Number(raw);
    if (!Number.isFinite(until) || until <= now) return null;
    return until;
  }

  async recordStrike(
    key: string,
    threshold: number,
    strikeWindowMs: number,
    banMs: number,
    now = Date.now()
  ): Promise<number | null> {
    const raw = await this.redis.eval(
      BAN_STRIKE_LUA,
      [strikeKey(key), banKey(key)],
      [String(threshold), String(strikeWindowMs), String(banMs), String(now)]
    );
    const text = raw == null ? "" : String(raw);
    if (!text) return null;
    const until = Number(text);
    return Number.isFinite(until) ? until : null;
  }

  async clear(key?: string): Promise<void> {
    if (!key) return;
    await this.redis.del(strikeKey(key), banKey(key));
  }

  cleanupExpired(): void {
    // Ban and strike keys expire with PEXPIRE / PX.
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __rateLimitBanBackend: BanBackend | undefined;
}

export function currentBanBackend(): BanBackend {
  if (!globalThis.__rateLimitBanBackend) {
    const redis = getRedis();
    globalThis.__rateLimitBanBackend = redis
      ? new RedisBanStore(redis)
      : new MemoryBanBackend(banStore);
  }
  return globalThis.__rateLimitBanBackend;
}
