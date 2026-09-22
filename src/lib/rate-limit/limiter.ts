/**
 * Rate Limiter Core — dispatches fixed-window, token-bucket, and sliding-window.
 * Multi-window configs AND together: every window must allow the request.
 */

import { extractClientIP, identityKey } from "./identity";
import { RateLimitStore, RateLimitConfig, RateLimitResult } from "./types";

export interface RateLimitRequestContext {
  url: string;
  method: string;
  headers: Headers;
  ip?: string;
}

export class RateLimiter {
  constructor(private store: RateLimitStore) {}

  async check(
    req: RateLimitRequestContext,
    config: RateLimitConfig,
    keyPrefix?: string
  ): Promise<RateLimitResult> {
    const ip = req.ip || extractClientIP(req.headers);
    const id = identityKey(req.headers, ip);
    const endpoint =
      keyPrefix || req.url.split("?")[0].split("/").pop() || "default";
    const baseKey = `${endpoint}:${id}`;

    const windows = [
      { windowMs: config.windowMs, limit: config.limit },
      ...(config.windows ?? []),
    ];

    let success = true;
    let remaining = Number.POSITIVE_INFINITY;
    let resetTime = 0;
    let limit = config.limit;

    for (const window of windows) {
      const key =
        windows.length > 1 ? `${baseKey}:w${window.windowMs}` : baseKey;
      const result = await this.store.consume(key, {
        ...config,
        windowMs: window.windowMs,
        limit: window.limit,
      });
      if (!result.allowed) success = false;
      if (result.remaining < remaining) {
        remaining = result.remaining;
        resetTime = result.resetTime;
        limit = result.limit;
      } else if (result.remaining === remaining && result.resetTime > resetTime) {
        resetTime = result.resetTime;
      }
    }

    return {
      success,
      limit,
      remaining: Number.isFinite(remaining) ? remaining : 0,
      resetTime,
    };
  }
}
