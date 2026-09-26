/**
 * Rate Limiter Core — dispatches fixed-window, token-bucket, and sliding-window.
 * Multi-window configs AND together: every window must allow the request.
 * A deny consumes none of the windows.
 */

import {
  ClientIpRequiredError,
  extractClientIP,
  resolveIdentity,
} from "./identity";
import { RateLimitStore, RateLimitConfig, RateLimitResult, WindowCheck } from "./types";

export interface RateLimitRequestContext {
  url: string;
  method: string;
  headers: Headers;
  /** Already-extracted trusted IP. Null means the IP could not be determined. */
  ip?: string | null;
  issuedKeys?: readonly string[];
}

export function rateLimitWindowKey(
  baseKey: string,
  index: number,
  windowMs: number,
  windowCount: number
): string {
  if (windowCount === 1) return baseKey;
  return `${baseKey}:w${index}:${windowMs}`;
}

export class RateLimiter {
  constructor(private store: RateLimitStore) {}

  async check(
    req: RateLimitRequestContext,
    config: RateLimitConfig,
    keyPrefix?: string
  ): Promise<RateLimitResult> {
    const trustedIp = req.ip === undefined ? extractClientIP(req.headers) : req.ip;
    const identity = resolveIdentity(req.headers, trustedIp, req.issuedKeys ?? []);
    if (!identity) throw new ClientIpRequiredError();

    const endpoint =
      keyPrefix || req.url.split("?")[0].split("/").pop() || "default";
    const baseKey = `${endpoint}:${identity}`;

    const windows = [
      { windowMs: config.windowMs, limit: config.limit },
      ...(config.windows ?? []),
    ];

    const checks: WindowCheck[] = windows.map((window, index) => ({
      key: rateLimitWindowKey(baseKey, index, window.windowMs, windows.length),
      config: {
        ...config,
        windowMs: window.windowMs,
        limit: window.limit,
      },
    }));

    const commit = await this.store.consumeAll(checks);

    let remaining = Number.POSITIVE_INFINITY;
    let resetTime = 0;
    let limit = config.limit;

    for (const result of commit.results) {
      if (result.remaining < remaining) {
        remaining = result.remaining;
        resetTime = result.resetTime;
        limit = result.limit;
      } else if (result.remaining === remaining && result.resetTime > resetTime) {
        resetTime = result.resetTime;
      }
    }

    return {
      success: commit.allowed,
      limit,
      remaining: Number.isFinite(remaining) ? remaining : 0,
      resetTime,
    };
  }
}
