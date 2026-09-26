import { banStore } from "./ban-store";
import { MemoryStore } from "./memory-store";
import type { RateLimitStore } from "./types";

declare global {
  // eslint-disable-next-line no-var
  var __rateLimitSweeper: ReturnType<typeof setInterval> | undefined;
}

const SWEEP_MS = 5 * 60 * 1000;

/** One process-local sweeper. Redis keys expire on their own TTL. */
export function ensureMemorySweeper(store: RateLimitStore): void {
  if (!(store instanceof MemoryStore)) return;
  if (globalThis.__rateLimitSweeper) return;
  const timer = setInterval(() => {
    store.cleanupExpired();
    banStore.cleanupExpired();
  }, SWEEP_MS);
  timer.unref?.();
  globalThis.__rateLimitSweeper = timer;
}
