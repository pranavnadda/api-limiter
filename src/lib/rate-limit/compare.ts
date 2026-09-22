/**
 * Isolated burst simulator for the algorithm comparison panel.
 * Uses its own MemoryStores and a fake clock so it never touches live counters.
 */

import { MemoryStore } from "./memory-store";
import { RateLimitAlgorithm, RateLimitConfig } from "./types";

export interface ComparePoint {
  index: number;
  t: number;
  remaining: number;
  allowed: boolean;
}

export interface CompareResult {
  limit: number;
  windowMs: number;
  burst: number;
  series: Record<RateLimitAlgorithm, ComparePoint[]>;
}

export async function compareAlgorithms(opts: {
  limit?: number;
  windowMs?: number;
  burst?: number;
}): Promise<CompareResult> {
  const limit = opts.limit ?? 10;
  const windowMs = opts.windowMs ?? 60_000;
  const burst = opts.burst ?? 20;

  const algorithms: RateLimitAlgorithm[] = [
    "fixed-window",
    "token-bucket",
    "sliding-window",
  ];

  const series = {} as Record<RateLimitAlgorithm, ComparePoint[]>;

  for (const algorithm of algorithms) {
    let t = windowMs - 5_000; // 5s before a fixed-window boundary
    const store = new MemoryStore(() => t);
    const config: RateLimitConfig = {
      windowMs,
      limit,
      algorithm,
      refillRate: limit / (windowMs / 1000),
    };
    const points: ComparePoint[] = [];

    // Burst at the end of a window, then the same burst just after the boundary.
    for (let i = 0; i < burst; i++) {
      if (i === Math.floor(burst / 2)) t = windowMs + 10;
      else t += 1;
      const result = await store.consume("compare:demo", config);
      points.push({
        index: i + 1,
        t,
        remaining: result.remaining,
        allowed: result.allowed,
      });
    }
    series[algorithm] = points;
  }

  return { limit, windowMs, burst, series };
}
