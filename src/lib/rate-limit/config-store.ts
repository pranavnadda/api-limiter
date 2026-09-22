/**
 * Mutable limiter config. Live dashboard edits write here; middleware reads here.
 * Seeded from the static table in config.ts.
 */

import { defaultConfig, endpointConfig } from "./config";
import { RateLimitAlgorithm, RateLimitConfig, WindowLimit } from "./types";

export interface LiveEndpointConfig extends RateLimitConfig {
  algorithm: RateLimitAlgorithm;
}

export interface ConfigSnapshot {
  endpoints: Record<string, LiveEndpointConfig>;
  defaultConfig: RateLimitConfig;
  allowlist: string[];
  blocklist: string[];
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
    this.ban = { ...this.ban, ...patch };
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
