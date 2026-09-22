/**
 * Temporary ban after repeated 429s. Separate from the rate-limit window.
 */

export class BanStore {
  private bans = new Map<string, number>();
  private strikes = new Map<string, { count: number; resetTime: number }>();

  isBanned(key: string, now = Date.now()): number | null {
    const until = this.bans.get(key);
    if (until && until > now) return until;
    if (until) this.bans.delete(key);
    return null;
  }

  /**
   * Record a 429. Returns ban-until timestamp if this strike crossed the threshold.
   */
  recordStrike(
    key: string,
    threshold: number,
    strikeWindowMs: number,
    banMs: number,
    now = Date.now()
  ): number | null {
    const existing = this.strikes.get(key);
    if (!existing || existing.resetTime <= now) {
      this.strikes.set(key, { count: 1, resetTime: now + strikeWindowMs });
      return null;
    }
    existing.count += 1;
    if (existing.count >= threshold) {
      const until = now + banMs;
      this.bans.set(key, until);
      this.strikes.delete(key);
      return until;
    }
    return null;
  }

  clear(key?: string): void {
    if (key) {
      this.bans.delete(key);
      this.strikes.delete(key);
      return;
    }
    this.bans.clear();
    this.strikes.clear();
  }

  cleanupExpired(now = Date.now()): void {
    for (const [key, until] of this.bans) {
      if (until <= now) this.bans.delete(key);
    }
    for (const [key, strike] of this.strikes) {
      if (strike.resetTime <= now) this.strikes.delete(key);
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __rateLimitBanStore: BanStore | undefined;
}

export const banStore =
  globalThis.__rateLimitBanStore ??
  (globalThis.__rateLimitBanStore = new BanStore());
