import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "@/lib/rate-limit/memory-store";
import { RateLimiter } from "@/lib/rate-limit/limiter";
import { BanStore } from "@/lib/rate-limit/ban-store";
import { ConfigStore } from "@/lib/rate-limit/config-store";
import { identityKey, extractApiKey, extractClientIP } from "@/lib/rate-limit/identity";
import { compareAlgorithms } from "@/lib/rate-limit/compare";
import { MetricsCollector } from "@/lib/rate-limit/metrics";

function headers(init?: Record<string, string>) {
  return new Headers(init);
}

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  it("allows requests within limit", async () => {
    const r = await store.increment("ping:1.2.3.4", 60_000);
    expect(r.count).toBe(1);
  });

  it("increments count for same key", async () => {
    await store.increment("ping:1.2.3.4", 60_000);
    const r = await store.increment("ping:1.2.3.4", 60_000);
    expect(r.count).toBe(2);
  });

  it("resets after window expires", async () => {
    await store.increment("ping:1.2.3.4", 1);
    await new Promise((r) => setTimeout(r, 10));
    const r = await store.increment("ping:1.2.3.4", 1);
    expect(r.count).toBe(1);
  });

  it("fixed-window blocks after limit", async () => {
    const cfg = { windowMs: 60_000, limit: 2, algorithm: "fixed-window" as const };
    await store.consume("k", cfg);
    await store.consume("k", cfg);
    const third = await store.consume("k", cfg);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });

  it("token-bucket refills with injected clock", async () => {
    let t = 0;
    const timed = new MemoryStore(() => t);
    const cfg = {
      windowMs: 10_000,
      limit: 2,
      algorithm: "token-bucket" as const,
      refillRate: 1,
    };
    expect((await timed.consume("tb", cfg)).allowed).toBe(true);
    expect((await timed.consume("tb", cfg)).allowed).toBe(true);
    expect((await timed.consume("tb", cfg)).allowed).toBe(false);
    t = 1_100;
    expect((await timed.consume("tb", cfg)).allowed).toBe(true);
  });

  it("sliding-window forgets timestamps outside the window", async () => {
    let t = 0;
    const timed = new MemoryStore(() => t);
    const cfg = { windowMs: 1000, limit: 2, algorithm: "sliding-window" as const };
    await timed.consume("sw", cfg);
    t = 10;
    await timed.consume("sw", cfg);
    t = 20;
    expect((await timed.consume("sw", cfg)).allowed).toBe(false);
    t = 1010;
    expect((await timed.consume("sw", cfg)).allowed).toBe(true);
  });
});

describe("RateLimiter", () => {
  it("uses API key identity over IP", async () => {
    const store = new MemoryStore();
    const limiter = new RateLimiter(store);
    const cfg = { windowMs: 60_000, limit: 1 };
    const first = await limiter.check(
      {
        url: "/api/ping",
        method: "GET",
        headers: headers({ "x-api-key": "alpha", "x-forwarded-for": "1.1.1.1" }),
        ip: "1.1.1.1",
      },
      cfg,
      "ping"
    );
    const secondSameKey = await limiter.check(
      {
        url: "/api/ping",
        method: "GET",
        headers: headers({ "x-api-key": "alpha", "x-forwarded-for": "9.9.9.9" }),
        ip: "9.9.9.9",
      },
      cfg,
      "ping"
    );
    const otherKey = await limiter.check(
      {
        url: "/api/ping",
        method: "GET",
        headers: headers({ "x-api-key": "beta" }),
        ip: "1.1.1.1",
      },
      cfg,
      "ping"
    );
    expect(first.success).toBe(true);
    expect(secondSameKey.success).toBe(false);
    expect(otherKey.success).toBe(true);
  });

  it("ANDs multi-window limits", async () => {
    const store = new MemoryStore();
    const limiter = new RateLimiter(store);
    const cfg = {
      windowMs: 1000,
      limit: 5,
      windows: [{ windowMs: 10_000, limit: 2 }],
    };
    const req = {
      url: "/api/ping",
      method: "GET",
      headers: headers({ "x-forwarded-for": "2.2.2.2" }),
      ip: "2.2.2.2",
    };
    expect((await limiter.check(req, cfg, "ping")).success).toBe(true);
    expect((await limiter.check(req, cfg, "ping")).success).toBe(true);
    expect((await limiter.check(req, cfg, "ping")).success).toBe(false);
  });
});

describe("identity", () => {
  it("prefers x-api-key, then bearer, then IP", () => {
    expect(extractApiKey(headers({ "x-api-key": "abc" }))).toBe("abc");
    expect(extractApiKey(headers({ authorization: "Bearer tok" }))).toBe("tok");
    expect(extractClientIP(headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe(
      "1.2.3.4"
    );
    expect(identityKey(headers({ "x-api-key": "abc" }), "1.2.3.4")).toBe("key:abc");
    expect(identityKey(headers(), "1.2.3.4")).toBe("ip:1.2.3.4");
  });
});

describe("BanStore", () => {
  it("bans after N strikes in the window", () => {
    const bans = new BanStore();
    expect(bans.recordStrike("ip:1", 3, 60_000, 15_000, 0)).toBeNull();
    expect(bans.recordStrike("ip:1", 3, 60_000, 15_000, 1)).toBeNull();
    const until = bans.recordStrike("ip:1", 3, 60_000, 15_000, 2);
    expect(until).toBe(15_002);
    expect(bans.isBanned("ip:1", 10)).toBe(15_002);
    expect(bans.isBanned("ip:1", 15_003)).toBeNull();
  });
});

describe("ConfigStore", () => {
  it("updates live endpoint limits", () => {
    const store = new ConfigStore();
    const next = store.setEndpoint("ping", { limit: 4, algorithm: "token-bucket" });
    expect(next.limit).toBe(4);
    expect(next.algorithm).toBe("token-bucket");
    expect(store.get("ping").limit).toBe(4);
  });
});

describe("compareAlgorithms", () => {
  it("returns three series of the same length", async () => {
    const result = await compareAlgorithms({ burst: 8, limit: 3, windowMs: 1000 });
    expect(result.series["fixed-window"]).toHaveLength(8);
    expect(result.series["token-bucket"]).toHaveLength(8);
    expect(result.series["sliding-window"]).toHaveLength(8);
  });
});

describe("MetricsCollector", () => {
  it("records audit entries for blocked requests", () => {
    const m = new MetricsCollector();
    m.recordRequest("ping", true, "ip:1", 200, 9);
    m.recordRequest("ping", false, "ip:1", 429, 0, {
      retryAfter: 12,
      reason: "rate_limit",
    });
    const snap = m.getSnapshot();
    expect(snap.total).toBe(2);
    expect(snap.blocked).toBe(1);
    expect(snap.auditLog[0]?.reason).toBe("rate_limit");
    expect(m.toPrometheus()).toContain("rate_limit_requests_total");
  });
});
