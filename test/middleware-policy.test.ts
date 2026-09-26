import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { MemoryBanBackend } from "@/lib/rate-limit/ban-backend";
import { BanStore } from "@/lib/rate-limit/ban-store";
import { configStore } from "@/lib/rate-limit/config-store";
import { MemoryStore } from "@/lib/rate-limit/memory-store";
import type { RateLimitStore } from "@/lib/rate-limit/types";

class BoomStore implements RateLimitStore {
  async increment(): Promise<{ count: number; resetTime: number }> {
    throw new Error("down");
  }
  async probe(): Promise<never> {
    throw new Error("down");
  }
  async consume(): Promise<never> {
    throw new Error("down");
  }
  async consumeAll(): Promise<never> {
    throw new Error("down");
  }
  async reset(): Promise<void> {
    throw new Error("down");
  }
}

function ping(forwarded?: string, apiKey?: string) {
  const headers = new Headers();
  if (forwarded) headers.set("x-forwarded-for", forwarded);
  if (apiKey) headers.set("x-api-key", apiKey);
  return new NextRequest("http://localhost/api/ping", { headers });
}

describe("middleware policy", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_UNTRUSTED_FORWARDED", "1");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    vi.stubEnv("API_KEYS", "");
    globalThis.__rateLimitStore = new MemoryStore();
    globalThis.__rateLimitBanBackend = new MemoryBanBackend(new BanStore());
    configStore.issuedKeys = [];
    configStore.setEndpoint("ping", { limit: 1, windowMs: 60_000 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    configStore.issuedKeys = [];
    configStore.setEndpoint("ping", { limit: 10, windowMs: 60_000, algorithm: "fixed-window" });
    globalThis.__rateLimitStore = undefined;
    globalThis.__rateLimitBanBackend = undefined;
  });

  it("returns 400 instead of sharing an unknown bucket", async () => {
    vi.stubEnv("ALLOW_UNTRUSTED_FORWARDED", "0");
    const res = await middleware(ping());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("CLIENT_IP_REQUIRED");
  });

  it("returns 503 when the store throws", async () => {
    globalThis.__rateLimitStore = new BoomStore();
    const res = await middleware(ping("203.0.113.8"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("LIMITER_UNAVAILABLE");
  });

  it("puts retryAfter under error.details", async () => {
    const first = await middleware(ping("203.0.113.9"));
    expect(first.status).toBe(200);
    const second = await middleware(ping("203.0.113.9"));
    expect(second.status).toBe(429);
    const body = await second.json();
    expect(body.error.details.retryAfter).toBeGreaterThan(0);
    expect(body.error.retryAfter).toBeUndefined();
  });

  it("does not let an arbitrary API key reset the IP bucket", async () => {
    const first = await middleware(ping("198.51.100.10", "one"));
    expect(first.status).toBe(200);
    const second = await middleware(ping("198.51.100.10", "two"));
    expect(second.status).toBe(429);
  });
});
