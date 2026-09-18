import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "@/lib/rate-limit/memory-store";

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
    await store.increment("ping:1.2.3.4", 1); // 1ms window
    // Wait slightly past window
    await new Promise((r) => setTimeout(r, 10));
    const r = await store.increment("ping:1.2.3.4", 1);
    expect(r.count).toBe(1);
  });
});
