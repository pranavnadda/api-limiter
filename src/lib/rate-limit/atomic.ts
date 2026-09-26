/**
 * In-process twin of CONSUME_ALL_LUA / BAN_STRIKE_LUA.
 * Fake Redis runs this synchronously so concurrent consumes cannot lose updates.
 * Keep the control flow aligned with scripts.ts.
 */

import type { CommitResult, ConsumeResult } from "./types";

export interface ConsumeSpec {
  algorithm: "fixed-window" | "token-bucket" | "sliding-window";
  limit: number;
  windowMs: number;
  refillRate: number;
  ttlMs: number;
  resetTime: number;
  idleTtlMs: number;
}

interface Entry {
  value: string;
  expiresAt: number | null;
}

export class ScriptKv {
  private map = new Map<string, Entry>();

  get(key: string, now: number): string | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: string, expiresAt: number | null): void {
    this.map.set(key, { value, expiresAt });
  }

  incr(key: string, now: number): number {
    const current = Number(this.get(key, now) ?? "0");
    const existing = this.map.get(key);
    const expiresAt =
      existing && existing.expiresAt !== null && existing.expiresAt > now
        ? existing.expiresAt
        : null;
    const next = current + 1;
    this.map.set(key, { value: String(next), expiresAt });
    return next;
  }

  pttl(key: string, now: number): number {
    const entry = this.map.get(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    if (entry.expiresAt <= now) {
      this.map.delete(key);
      return -2;
    }
    return entry.expiresAt - now;
  }

  pexpire(key: string, ttlMs: number, now: number): void {
    const entry = this.map.get(key);
    if (!entry) return;
    entry.expiresAt = now + ttlMs;
  }

  del(key: string): void {
    this.map.delete(key);
  }
}

function tokenReset(
  now: number,
  allowed: boolean,
  tokens: number,
  refillPerSec: number,
  windowMs: number
): number {
  const tokensUntilOne = allowed ? 0 : Math.max(0, 1 - tokens);
  const msUntilToken =
    refillPerSec > 0 ? Math.ceil((tokensUntilOne / refillPerSec) * 1000) : windowMs;
  if (!allowed) return now + msUntilToken;
  if (refillPerSec <= 0) return now + windowMs;
  return now + Math.ceil((1 / refillPerSec) * 1000);
}

export function applyConsumeAll(
  kv: ScriptKv,
  keys: string[],
  specs: ConsumeSpec[],
  now: number,
  dry: boolean
): CommitResult {
  const planned: Array<{ result: ConsumeResult; commit: () => void }> = [];
  let denied = false;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const key = keys[i];
    if (spec.algorithm === "fixed-window") {
      const count = Number(kv.get(key, now) ?? "0");
      const nextCount = count + 1;
      const allowed = nextCount <= spec.limit;
      if (!allowed) denied = true;
      planned.push({
        result: {
          allowed,
          count: allowed ? nextCount : count,
          remaining: allowed ? Math.max(0, spec.limit - nextCount) : 0,
          resetTime: spec.resetTime,
          limit: spec.limit,
        },
        commit: () => {
          kv.incr(key, now);
          if (kv.pttl(key, now) < 0) kv.pexpire(key, spec.ttlMs, now);
        },
      });
      continue;
    }

    if (spec.algorithm === "token-bucket") {
      const raw = kv.get(key, now);
      let tokens = spec.limit;
      let lastRefill = now;
      if (raw) {
        const state = JSON.parse(raw) as { tokens: number; lastRefill: number };
        const elapsed = Math.max(0, (now - state.lastRefill) / 1000);
        tokens = Math.min(spec.limit, state.tokens + elapsed * spec.refillRate);
        lastRefill = now;
      }
      const allowed = tokens >= 1;
      const stored = allowed ? tokens - 1 : tokens;
      if (!allowed) denied = true;
      planned.push({
        result: {
          allowed,
          count: Math.ceil(spec.limit - stored),
          remaining: Math.max(0, Math.floor(stored)),
          resetTime: tokenReset(now, allowed, stored, spec.refillRate, spec.windowMs),
          limit: spec.limit,
        },
        commit: () => {
          kv.set(
            key,
            JSON.stringify({ tokens: stored, lastRefill }),
            now + spec.idleTtlMs
          );
        },
      });
      continue;
    }

    const cutoff = now - spec.windowMs;
    const raw = kv.get(key, now);
    let timestamps: number[] = [];
    if (raw) {
      const state = JSON.parse(raw) as { timestamps?: number[] };
      timestamps = (state.timestamps ?? []).filter((t) => t > cutoff);
    }
    const allowed = timestamps.length < spec.limit;
    if (!allowed) denied = true;
    const stored = allowed ? [...timestamps, now] : timestamps;
    const oldest = stored[0] ?? now;
    planned.push({
      result: {
        allowed,
        count: stored.length,
        remaining: allowed ? Math.max(0, spec.limit - stored.length) : 0,
        resetTime: oldest + spec.windowMs,
        limit: spec.limit,
      },
      commit: () => {
        kv.set(
          key,
          JSON.stringify({ timestamps: stored, windowMs: spec.windowMs }),
          now + spec.windowMs
        );
      },
    });
  }

  if (!denied && !dry) {
    for (const entry of planned) entry.commit();
  }

  return { allowed: !denied, results: planned.map((entry) => entry.result) };
}

export function applyBanStrike(
  kv: ScriptKv,
  strikeKey: string,
  banKey: string,
  threshold: number,
  strikeTtl: number,
  banMs: number,
  now: number
): string {
  const count = kv.incr(strikeKey, now);
  if (count === 1) kv.pexpire(strikeKey, strikeTtl, now);
  if (count >= threshold) {
    const until = now + banMs;
    kv.set(banKey, String(until), now + banMs);
    kv.del(strikeKey);
    return String(until);
  }
  return "";
}
