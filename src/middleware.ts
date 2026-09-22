/**
 * Next.js Middleware — Rate Limiting
 *
 * Order: allowlist skip → blocklist 403 → temp ban → algorithm check.
 * Fail-open if the limiter throws.
 */

import { NextResponse, NextRequest } from "next/server";
import { MemoryStore } from "@/lib/rate-limit/memory-store";
import { RateLimiter } from "@/lib/rate-limit/limiter";
import { configStore } from "@/lib/rate-limit/config-store";
import { banStore } from "@/lib/rate-limit/ban-store";
import { tryCreateRedisStore } from "@/lib/rate-limit/redis-store";
import { extractClientIP, identityKey } from "@/lib/rate-limit/identity";
import { tooManyRequests } from "@/lib/api-errors";
import { metrics } from "@/lib/rate-limit/metrics";
import type { RateLimitStore } from "@/lib/rate-limit/types";

declare global {
  // eslint-disable-next-line no-var
  var __rateLimitStore: RateLimitStore | undefined;
}

function createStore(): RateLimitStore {
  const redis = tryCreateRedisStore();
  if (redis) return redis;
  return globalThis.__rateLimitStore instanceof MemoryStore
    ? globalThis.__rateLimitStore
    : new MemoryStore();
}

const store =
  globalThis.__rateLimitStore ?? (globalThis.__rateLimitStore = createStore());
const limiter = new RateLimiter(store);

const CLEANUP_INTERVAL = 5 * 60 * 1000;
let lastCleanup = 0;

function getEndpointKey(req: NextRequest): string | null {
  const url = req.nextUrl.pathname;
  if (!url.startsWith("/api/")) return null;
  const path = url.replace("/api/", "");
  const segments = path.split("/");
  return segments[0] || null;
}

function jsonError(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string>,
  extra?: Record<string, unknown>
) {
  return new Response(
    JSON.stringify({
      success: false,
      error: { code, message, ...extra },
    }),
    {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    }
  );
}

export async function middleware(req: NextRequest) {
  const endpoint = getEndpointKey(req);
  if (!endpoint) {
    return NextResponse.next();
  }

  const ip = extractClientIP(req.headers);
  const identity = identityKey(req.headers, ip);
  const now = Date.now();

  if (now - lastCleanup > CLEANUP_INTERVAL) {
    if (store instanceof MemoryStore) store.cleanupExpired();
    banStore.cleanupExpired(now);
    lastCleanup = now;
  }

  if (configStore.isBlocked(identity, ip)) {
    metrics.recordRequest(endpoint, false, identity, 403, 0, {
      retryAfter: 0,
      reason: "blocklist",
    });
    return jsonError(403, "BLOCKED", "This client is on the blocklist.", {});
  }

  if (configStore.isAllowed(identity, ip)) {
    metrics.recordRequest(endpoint, true, identity, 200, 999);
    return NextResponse.next();
  }

  const bannedUntil = banStore.isBanned(identity, now);
  if (bannedUntil) {
    const retryAfter = Math.max(1, Math.ceil((bannedUntil - now) / 1000));
    metrics.recordRequest(endpoint, false, identity, 429, 0, {
      retryAfter,
      reason: "ban",
    });
    return jsonError(
      429,
      "BANNED",
      `Temporarily banned. Try again in ${retryAfter}s.`,
      { "Retry-After": String(retryAfter) },
      { retryAfter }
    );
  }

  const config = configStore.get(endpoint);

  try {
    const result = await limiter.check(
      {
        url: req.nextUrl.pathname,
        method: req.method,
        headers: req.headers,
        ip,
      },
      config,
      endpoint
    );

    const rateLimitHeaders: Record<string, string> = {
      "X-RateLimit-Limit": String(result.limit),
      "X-RateLimit-Remaining": String(result.remaining),
      "X-RateLimit-Reset": String(result.resetTime),
    };

    if (!result.success) {
      const retryAfter = Math.max(
        1,
        Math.ceil((result.resetTime - now) / 1000)
      );

      const banUntil = banStore.recordStrike(
        identity,
        configStore.ban.threshold,
        configStore.ban.strikeWindowMs,
        configStore.ban.banMs,
        now
      );

      metrics.recordRequest(endpoint, false, identity, 429, 0, {
        retryAfter: banUntil
          ? Math.ceil((banUntil - now) / 1000)
          : retryAfter,
        reason: banUntil ? "ban" : "rate_limit",
      });

      const wait = banUntil
        ? Math.ceil((banUntil - now) / 1000)
        : retryAfter;
      const err = tooManyRequests(
        banUntil
          ? `Temporarily banned after repeated 429s. Try again in ${wait}s.`
          : `Rate limit exceeded. Try again in ${wait}s.`,
        wait
      );

      return jsonError(
        429,
        banUntil ? "BANNED" : "RATE_LIMITED",
        err.message,
        { ...rateLimitHeaders, "Retry-After": String(wait) },
        { retryAfter: wait }
      );
    }

    metrics.recordRequest(endpoint, true, identity, 200, result.remaining);

    const res = NextResponse.next();
    for (const [name, value] of Object.entries(rateLimitHeaders)) {
      res.headers.set(name, value);
    }
    return res;
  } catch (err) {
    console.error("[Middleware] Rate limiter error:", err);
    return NextResponse.next();
  }
}

export const config = {
  matcher: ["/api/:path*"],
  runtime: "nodejs",
};
