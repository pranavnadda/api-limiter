/**
 * Next.js Middleware — Rate Limiting
 *
 * Order: blocklist 403 → allowlist skip → temp ban → algorithm check.
 * Missing trusted identity returns 400. Store errors fail closed with 503.
 */

import { NextResponse, NextRequest } from "next/server";
import { fail } from "@/lib/api-response";
import { ClientIpRequiredError, extractClientIP, resolveIdentity } from "@/lib/rate-limit/identity";
import { MemoryStore } from "@/lib/rate-limit/memory-store";
import { RateLimiter } from "@/lib/rate-limit/limiter";
import { configStore } from "@/lib/rate-limit/config-store";
import { currentBanBackend } from "@/lib/rate-limit/ban-backend";
import { tryCreateRedisStore } from "@/lib/rate-limit/redis-store";
import { metrics } from "@/lib/rate-limit/metrics";
import { ensureMemorySweeper } from "@/lib/rate-limit/sweeper";
import type { RateLimitStore } from "@/lib/rate-limit/types";

declare global {
  // eslint-disable-next-line no-var
  var __rateLimitStore: RateLimitStore | undefined;
}

function createStore(): RateLimitStore {
  const redis = tryCreateRedisStore();
  if (redis) return redis;
  return new MemoryStore();
}

function currentStore(): RateLimitStore {
  if (!globalThis.__rateLimitStore) {
    globalThis.__rateLimitStore = createStore();
  }
  return globalThis.__rateLimitStore;
}

function getEndpointKey(req: NextRequest): string | null {
  const url = req.nextUrl.pathname;
  if (!url.startsWith("/api/")) return null;
  const path = url.replace("/api/", "");
  const segments = path.split("/");
  return segments[0] || null;
}

export async function middleware(req: NextRequest) {
  const endpoint = getEndpointKey(req);
  if (!endpoint) {
    return NextResponse.next();
  }

  const store = currentStore();
  ensureMemorySweeper(store);
  const limiter = new RateLimiter(store);
  const bans = currentBanBackend();

  try {
    await configStore.ensureFresh();
    const ip = extractClientIP(req.headers);
    const identity = resolveIdentity(req.headers, ip, configStore.issuedKeys);
    if (!identity) throw new ClientIpRequiredError();

    if (configStore.isBlocked(identity, ip ?? "")) {
      metrics.recordRequest(endpoint, "blocklist", identity, 403, 0, { retryAfter: 0 });
      return fail("BLOCKED", "This client is on the blocklist.", 403);
    }

    const config = configStore.get(endpoint);
    if (configStore.isAllowed(identity, ip ?? "")) {
      metrics.recordRequest(endpoint, "allowed", identity, null, config.limit);
      return NextResponse.next();
    }

    const now = Date.now();
    const bannedUntil = await bans.isBanned(identity, now);
    if (bannedUntil) {
      const retryAfter = Math.max(1, Math.ceil((bannedUntil - now) / 1000));
      metrics.recordRequest(endpoint, "banned", identity, 429, 0, { retryAfter });
      return fail(
        "BANNED",
        `Temporarily banned. Try again in ${retryAfter}s.`,
        429,
        { retryAfter },
        { headers: { "Retry-After": String(retryAfter) } }
      );
    }

    const result = await limiter.check(
      {
        url: req.nextUrl.pathname,
        method: req.method,
        headers: req.headers,
        ip,
        issuedKeys: configStore.issuedKeys,
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
      const retryAfter = Math.max(1, Math.ceil((result.resetTime - now) / 1000));
      const banUntil = await bans.recordStrike(
        identity,
        configStore.ban.threshold,
        configStore.ban.strikeWindowMs,
        configStore.ban.banMs,
        now
      );
      const wait = banUntil ? Math.max(1, Math.ceil((banUntil - now) / 1000)) : retryAfter;
      metrics.recordRequest(endpoint, banUntil ? "banned" : "rate_limited", identity, 429, 0, {
        retryAfter: wait,
      });
      return fail(
        banUntil ? "BANNED" : "RATE_LIMITED",
        banUntil
          ? `Temporarily banned after repeated 429s. Try again in ${wait}s.`
          : `Rate limit exceeded. Try again in ${wait}s.`,
        429,
        { retryAfter: wait },
        { headers: { ...rateLimitHeaders, "Retry-After": String(wait) } }
      );
    }

    metrics.recordRequest(endpoint, "allowed", identity, null, result.remaining);
    const res = NextResponse.next();
    for (const [name, value] of Object.entries(rateLimitHeaders)) {
      res.headers.set(name, value);
    }
    return res;
  } catch (err) {
    if (err instanceof ClientIpRequiredError) {
      return fail("CLIENT_IP_REQUIRED", err.message, 400);
    }
    console.error("[Middleware] Rate limiter error:", err);
    return fail("LIMITER_UNAVAILABLE", "Rate limiter is unavailable.", 503);
  }
}

export const config = {
  matcher: ["/api/:path*"],
  runtime: "nodejs",
};
