import { describe, expect, it } from "vitest";
import { RedisBanStore } from "@/lib/rate-limit/ban-backend";
import { counterKey, RedisStore } from "@/lib/rate-limit/redis-store";
import { CONSUME_ALL_LUA } from "@/lib/rate-limit/scripts";
import { FakeRedis } from "./fake-redis";

describe("RedisStore", () => {
  it("keeps a concurrent fixed window from allowing more than the limit", async () => {
    const redis = new FakeRedis();
    const store = new RedisStore(redis);
    const config = { windowMs: 60_000, limit: 5, algorithm: "fixed-window" as const };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.consumeAll([{ key: "ping:ip:1", config }]))
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(redis.evalCount).toBe(20);
    expect(CONSUME_ALL_LUA).toContain("INCR");
    expect(CONSUME_ALL_LUA).toContain("PEXPIRE");
    expect(redis.kv.get(counterKey("fixed-window", "ping:ip:1"), Date.now())).toBe("5");
  });

  it("does not consume the other window when one window denies", async () => {
    const redis = new FakeRedis();
    const store = new RedisStore(redis);
    const checks = [
      {
        key: "ping:ip:1:w0:1000",
        config: { windowMs: 1_000, limit: 5, algorithm: "fixed-window" as const },
      },
      {
        key: "ping:ip:1:w1:10000",
        config: { windowMs: 10_000, limit: 2, algorithm: "fixed-window" as const },
      },
    ];
    expect((await store.consumeAll(checks)).allowed).toBe(true);
    expect((await store.consumeAll(checks)).allowed).toBe(true);
    expect((await store.consumeAll(checks)).allowed).toBe(false);
    const now = Date.now();
    expect(redis.kv.get(counterKey("fixed-window", checks[0].key), now)).toBe("2");
    expect(redis.kv.get(counterKey("fixed-window", checks[1].key), now)).toBe("2");
  });
});

describe("RedisBanStore", () => {
  it("bans from an atomic strike script", async () => {
    let now = 1_000;
    const redis = new FakeRedis(() => now);
    const bans = new RedisBanStore(redis);
    expect(await bans.recordStrike("ip:1", 2, 60_000, 15_000, now)).toBeNull();
    now = 1_100;
    expect(await bans.recordStrike("ip:1", 2, 60_000, 15_000, now)).toBe(16_100);
    expect(await bans.isBanned("ip:1", now)).toBe(16_100);
    now = 20_000;
    expect(await bans.isBanned("ip:1", now)).toBeNull();
  });
});
