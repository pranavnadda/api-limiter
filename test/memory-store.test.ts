import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { MemoryStore } from "@/lib/rate-limit/memory-store";
import { RateLimiter, rateLimitWindowKey } from "@/lib/rate-limit/limiter";
import { BanStore } from "@/lib/rate-limit/ban-store";
import { ConfigStore } from "@/lib/rate-limit/config-store";
import {
  resolveIdentity,
  extractApiKey,
  extractClientIP,
  maskIdentity,
} from "@/lib/rate-limit/identity";
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
  it("uses an issued API key and ignores unissued keys", async () => {
    const store = new MemoryStore();
    const limiter = new RateLimiter(store);
    const cfg = { windowMs: 60_000, limit: 1 };
    const issuedKeys = ["alpha"];
    const first = await limiter.check(
      {
        url: "/api/ping",
        method: "GET",
        headers: headers({ "x-api-key": "alpha", "x-forwarded-for": "1.1.1.1" }),
        ip: "1.1.1.1",
        issuedKeys,
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
        issuedKeys,
      },
      cfg,
      "ping"
    );
    const unissuedSharesIp = await limiter.check(
      {
        url: "/api/ping",
        method: "GET",
        headers: headers({ "x-api-key": "beta" }),
        ip: "1.1.1.1",
        issuedKeys,
      },
      cfg,
      "ping"
    );
    const sameIpAgain = await limiter.check(
      {
        url: "/api/ping",
        method: "GET",
        headers: headers({ "x-api-key": "gamma" }),
        ip: "1.1.1.1",
        issuedKeys,
      },
      cfg,
      "ping"
    );
    expect(first.success).toBe(true);
    expect(secondSameKey.success).toBe(false);
    expect(unissuedSharesIp.success).toBe(true);
    expect(sameIpAgain.success).toBe(false);
  });

  it("ANDs multi-window limits without consuming the sibling window on deny", async () => {
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
    const base = "ping:ip:2.2.2.2";
    expect(store.getCount(rateLimitWindowKey(base, 0, 1000, 2))).toBe(2);
    expect(store.getCount(rateLimitWindowKey(base, 1, 10_000, 2))).toBe(2);
  });
});

describe("identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers an issued key, then a trusted IP", () => {
    expect(extractApiKey(headers({ "x-api-key": "abc" }))).toBe("abc");
    expect(extractApiKey(headers({ authorization: "Bearer tok" }))).toBe("tok");
    expect(resolveIdentity(headers({ "x-api-key": "abc" }), "1.2.3.4", ["abc"])).toBe("key:abc");
    expect(resolveIdentity(headers({ "x-api-key": "nope" }), "1.2.3.4", ["abc"])).toBe(
      "ip:1.2.3.4"
    );
    expect(resolveIdentity(headers(), null, [])).toBeNull();
  });

  it("takes trusted hops from the right and ignores forwarding when hops are 0", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_UNTRUSTED_FORWARDED", "1");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    expect(
      extractClientIP(headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))
    ).toBeNull();

    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    expect(
      extractClientIP(headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))
    ).toBe("10.0.0.1");
  });

  it("honors the leftmost forwarded IP only for the development simulator flag", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_UNTRUSTED_FORWARDED", "1");
    expect(
      extractClientIP(headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))
    ).toBe("1.2.3.4");
    expect(extractClientIP(headers())).toBe("127.0.0.1");
  });

  it("masks short and long identities the same way", () => {
    expect(maskIdentity("ip:1.2.3.4")).toBe("ip:1…");
    expect(maskIdentity("key:super-secret-token")).toBe("key:…");
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

  it("rejects non-finite and non-positive ban settings", () => {
    const store = new ConfigStore();
    expect(() => store.setBan({ threshold: 0 })).toThrow(/threshold/);
    expect(() => store.setBan({ threshold: Number.NaN })).toThrow(/threshold/);
    expect(() => store.setBan({ banMs: 10 })).toThrow(/banMs/);
  });
});

describe("compareAlgorithms", () => {
  it("returns three series of the same length", async () => {
    const result = await compareAlgorithms({ burst: 8, limit: 3, windowMs: 1000 });
    expect(result.series["fixed-window"]).toHaveLength(8);
    expect(result.series["token-bucket"]).toHaveLength(8);
    expect(result.series["sliding-window"]).toHaveLength(8);
  });

  it("rejects a burst above the cap", async () => {
    await expect(compareAlgorithms({ burst: 101 })).rejects.toThrow(/burst/);
  });
});

describe("MetricsCollector", () => {
  it("records audit entries for blocked requests and does not double-count bans", () => {
    const m = new MetricsCollector();
    m.recordRequest("ping", "allowed", "ip:1.2.3.4", null, 9);
    m.recordRequest("ping", "rate_limited", "ip:1.2.3.4", 429, 0, {
      retryAfter: 12,
    });
    m.recordRequest("ping", "banned", "ip:1.2.3.4", 429, 0, { retryAfter: 30 });
    const snap = m.getSnapshot();
    expect(snap.total).toBe(3);
    expect(snap.allowed).toBe(1);
    expect(snap.blocked).toBe(1);
    expect(snap.banned).toBe(1);
    expect(snap.allowed + snap.blocked + snap.banned).toBe(snap.total);
    expect(snap.auditLog[0]?.reason).toBe("ban");
    expect(snap.auditLog[0]?.identity).toBe("ip:1…");
    expect(snap.recentRequests[2]?.status).toBeNull();
    expect(m.toPrometheus()).toContain('result="banned"');
  });

  it("caps request history by count", () => {
    const m = new MetricsCollector();
    for (let i = 0; i < 5_050; i++) {
      m.recordRequest("ping", "allowed", "ip:1.2.3.4", null, 1);
    }
    const internal = m as unknown as { requestHistory: unknown[] };
    expect(internal.requestHistory.length).toBeLessThanOrEqual(5_000);
  });
});

describe("token bucket eviction", () => {
  it("drops idle token buckets and expired sliding buckets", () => {
    let t = 0;
    const store = new MemoryStore(() => t);
    store.consume("tb", {
      windowMs: 1_000,
      limit: 2,
      algorithm: "token-bucket",
      refillRate: 1,
    });
    store.consume("sw", {
      windowMs: 1_000,
      limit: 2,
      algorithm: "sliding-window",
    });
    t = 60_001;
    expect(store.cleanupExpired()).toBeGreaterThanOrEqual(1);
    expect(store.getCount("tb")).toBeUndefined();
    expect(store.getCount("sw")).toBeUndefined();
  });
});
