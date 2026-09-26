import { Redis } from "@upstash/redis";

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export function upstashRedis(url: string, token: string): RedisLike {
  const redis = new Redis({ url, token });
  return {
    async get(key) {
      const value = await redis.get<unknown>(key);
      if (value == null) return null;
      return typeof value === "string" ? value : JSON.stringify(value);
    },
    async set(key, value, ttlMs) {
      if (ttlMs && ttlMs > 0) {
        await redis.set(key, value, { px: Math.ceil(ttlMs) });
        return;
      }
      await redis.set(key, value);
    },
    async del(...keys) {
      if (keys.length === 0) return;
      await redis.del(...keys);
    },
    eval(script, keys, args) {
      return redis.eval(script, keys, args);
    },
  };
}

let cached: RedisLike | null | undefined;

export function getRedis(): RedisLike | null {
  if (cached !== undefined) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    cached = null;
    return null;
  }
  cached = upstashRedis(url, token);
  return cached;
}
