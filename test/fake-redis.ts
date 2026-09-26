import type { RedisLike } from "@/lib/rate-limit/redis-client";
import {
  applyBanStrike,
  applyConsumeAll,
  ScriptKv,
  type ConsumeSpec,
} from "@/lib/rate-limit/atomic";
import { BAN_STRIKE_LUA, CONSUME_ALL_LUA } from "@/lib/rate-limit/scripts";

/** In-memory Redis. EVAL runs to completion before yielding; GET/SET yield first. */
export class FakeRedis implements RedisLike {
  readonly kv = new ScriptKv();
  evalCount = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(key: string): Promise<string | null> {
    await Promise.resolve();
    return this.kv.get(key, this.now());
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    await Promise.resolve();
    this.kv.set(key, value, ttlMs ? this.now() + ttlMs : null);
  }

  async del(...keys: string[]): Promise<void> {
    await Promise.resolve();
    for (const key of keys) this.kv.del(key);
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    this.evalCount += 1;
    return this.evalSync(script, keys, args);
  }

  private evalSync(script: string, keys: string[], args: string[]): unknown {
    if (script === CONSUME_ALL_LUA) {
      const now = Number(args[0]);
      const specs = JSON.parse(args[1]) as ConsumeSpec[];
      return applyConsumeAll(this.kv, keys, specs, now, args[2] === "1");
    }
    if (script === BAN_STRIKE_LUA) {
      return applyBanStrike(
        this.kv,
        keys[0],
        keys[1],
        Number(args[0]),
        Number(args[1]),
        Number(args[2]),
        Number(args[3])
      );
    }
    throw new Error("unknown redis script");
  }
}
