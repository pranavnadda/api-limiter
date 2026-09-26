/**
 * Mutable limiter config. Live dashboard edits write here; middleware reads here.
 * Seeded from the static table in config.ts.
 */

import { defaultConfig, endpointConfig } from "./config";
import { parseIssuedKeys } from "./identity";
import { getRedis, type RedisLike } from "./redis-client";
import { RateLimitAlgorithm, RateLimitConfig, WindowLimit } from "./types";

const CONFIG_KEY = "rl:config";
const CONFIG_CACHE_MS = 1000;

export interface LiveEndpointConfig extends RateLimitConfig {
  algorithm: RateLimitAlgorithm;
}

export interface ConfigSnapshot {
  endpoints: Record<string, LiveEndpointConfig>;
  defaultConfig: RateLimitConfig;
  allowlist: string[];
  blocklist: string[];
  issuedKeys: string[];
  ban: {
    threshold: number;
    strikeWindowMs: number;
    banMs: number;
  };
}

function toLive(config: RateLimitConfig): LiveEndpointConfig {
  return {
    windowMs: config.windowMs,
    limit: config.limit,
    algorithm: config.algorithm ?? "fixed-window",
    refillRate: config.refillRate,
    windows: config.windows ? [...config.windows] : undefined,
  };
}

export class ConfigStore {
  private endpoints: Record<string, LiveEndpointConfig> = Object.fromEntries(
    Object.entries(endpointConfig).map(([name, cfg]) => [name, toLive(cfg)])
  );
  allowlist: string[] = [];
  blocklist: string[] = [];
  issuedKeys: string[] = parseIssuedKeys(process.env.API_KEYS);
  private redisChecked = false;
  private redis: RedisLike | null = null;
  private loadedAt = 0;
  ban = {
    threshold: 5,
    strikeWindowMs: 60_000,
    banMs: 15 * 60_000,
  };

  get(endpoint: string): LiveEndpointConfig | RateLimitConfig {
    return this.endpoints[endpoint] ?? defaultConfig;
  }

  list(): ConfigSnapshot {
    return {
      endpoints: structuredClone(this.endpoints),
      defaultConfig: { ...defaultConfig },
      allowlist: [...this.allowlist],
      blocklist: [...this.blocklist],
      issuedKeys: [...this.issuedKeys],
      ban: { ...this.ban },
    };
  }

  setEndpoint(
    endpoint: string,
    patch: {
      limit?: number;
      windowMs?: number;
      algorithm?: RateLimitAlgorithm;
      refillRate?: number;
      windows?: WindowLimit[] | null;
    }
  ): LiveEndpointConfig {
    const current = toLive(this.endpoints[endpoint] ?? defaultConfig);
    if (patch.limit !== undefined) {
      if (!Number.isFinite(patch.limit) || patch.limit < 1) {
        throw new Error("limit must be a positive number");
      }
      current.limit = Math.floor(patch.limit);
    }
    if (patch.windowMs !== undefined) {
      if (!Number.isFinite(patch.windowMs) || patch.windowMs < 100) {
        throw new Error("windowMs must be at least 100");
      }
      current.windowMs = Math.floor(patch.windowMs);
    }
    if (patch.algorithm) current.algorithm = patch.algorithm;
    if (patch.refillRate !== undefined) {
      current.refillRate = patch.refillRate > 0 ? patch.refillRate : undefined;
    }
    if (patch.windows === null) {
      current.windows = undefined;
    } else if (patch.windows) {
      current.windows = patch.windows.filter(
        (w) => w.windowMs >= 100 && w.limit >= 1
      );
      if (current.windows.length === 0) current.windows = undefined;
    }
    this.endpoints[endpoint] = current;
    return current;
  }

  setLists(allowlist?: string[], blocklist?: string[]): void {
    if (allowlist) {
      this.allowlist = allowlist.map((s) => s.trim()).filter(Boolean);
    }
    if (blocklist) {
      this.blocklist = blocklist.map((s) => s.trim()).filter(Boolean);
    }
  }

  setBan(patch: Partial<ConfigStore["ban"]>): void {
    const next = { ...this.ban, ...patch };
    if (!Number.isFinite(next.threshold) || next.threshold < 1) {
      throw new Error("threshold must be a finite number >= 1");
    }
    if (!Number.isFinite(next.strikeWindowMs) || next.strikeWindowMs < 100) {
      throw new Error("strikeWindowMs must be a finite number >= 100");
    }
    if (!Number.isFinite(next.banMs) || next.banMs < 1000) {
      throw new Error("banMs must be a finite number >= 1000");
    }
    this.ban = {
      threshold: Math.floor(next.threshold),
      strikeWindowMs: Math.floor(next.strikeWindowMs),
      banMs: Math.floor(next.banMs),
    };
  }

  async ensureFresh(): Promise<void> {
    const redis = this.client();
    if (!redis) return;
    const now = Date.now();
    if (this.loadedAt && now - this.loadedAt < CONFIG_CACHE_MS) return;
    const raw = await redis.get(CONFIG_KEY);
    if (!raw) {
      await redis.set(CONFIG_KEY, JSON.stringify(this.list()));
    } else {
      this.applySnapshot(JSON.parse(raw) as ConfigSnapshot);
    }
    this.loadedAt = Date.now();
  }

  async persist(): Promise<void> {
    const redis = this.client();
    if (!redis) return;
    await redis.set(CONFIG_KEY, JSON.stringify(this.list()));
    this.loadedAt = Date.now();
  }

  private client(): RedisLike | null {
    if (!this.redisChecked) {
      this.redis = getRedis();
      this.redisChecked = true;
    }
    return this.redis;
  }

  private applySnapshot(snapshot: ConfigSnapshot): void {
    if (!snapshot || typeof snapshot !== "object") {
      throw new Error("Invalid limiter config snapshot");
    }
    this.endpoints = Object.fromEntries(
      Object.entries(snapshot.endpoints ?? {}).map(([name, cfg]) => [name, toLive(cfg)])
    );
    this.allowlist = [...(snapshot.allowlist ?? [])];
    this.blocklist = [...(snapshot.blocklist ?? [])];
    this.issuedKeys = [...(snapshot.issuedKeys ?? this.issuedKeys)];
    this.setBan(snapshot.ban ?? this.ban);
  }

  isAllowed(identity: string, ip: string): boolean {
    return this.allowlist.includes(identity) || this.allowlist.includes(ip);
  }

  isBlocked(identity: string, ip: string): boolean {
    return this.blocklist.includes(identity) || this.blocklist.includes(ip);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __rateLimitConfigStore: ConfigStore | undefined;
}

export const configStore =
  globalThis.__rateLimitConfigStore ??
  (globalThis.__rateLimitConfigStore = new ConfigStore());
