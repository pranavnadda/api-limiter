/**
 * Metrics Collector — Observability for Rate Limiter
 *
 * WHY: You can't improve what you can't measure. This tracks every request
 * (allowed and blocked) so the dashboard can show what's happening in real-time.
 *
 * DESIGN DECISION: Separate class instead of embedding in middleware
 * - Keeps middleware focused on rate limiting logic
 * - Makes testing easier (mock the collector)
 * - Allows swapping in Redis-backed metrics later without touching middleware
 */

export interface EndpointStats {
  total: number;
  allowed: number;
  blocked: number;
}

export interface MetricsSnapshot {
  total: number;
  allowed: number;
  blocked: number;
  activeIPs: number;
  requestsPerSecond: number;
  endpoints: Record<string, EndpointStats>;
  recentRequests: Array<{
    timestamp: number;
    ip: string;
    endpoint: string;
    status: number;
    remaining: number;
  }>;
}

interface RequestRecord {
  timestamp: number;
  endpoint: string;
  allowed: boolean;
}

/**
 * IP tracking with TTL (time-to-live).
 * WHY: We need to know "how many unique visitors in the last N minutes"
 * without keeping stale IPs forever (memory leak).
 */
interface IPEntry {
  ip: string;
  lastSeen: number;
}

export class MetricsCollector {
  private totalRequests = 0;
  private allowedRequests = 0;
  private blockedRequests = 0;
  private endpointStats = new Map<string, EndpointStats>();
  private activeIPsSet = new Map<string, IPEntry>();
  private requestHistory: RequestRecord[] = [];
  private recentRequests: MetricsSnapshot["recentRequests"] = [];

  // Configuration
  private readonly IP_TTL = 300_000; // 5 minutes
  private readonly HISTORY_WINDOW = 60_000; // 1 minute for req/s calculation
  private readonly MAX_RECENT_REQUESTS = 50; // Keep last 50 for display

  /**
   * Record a request passing through the rate limiter.
   *
   * WHY: Called by middleware on EVERY request, before and after rate check.
   * This is the single source of truth for what happened.
   */
  recordRequest(
    endpoint: string,
    allowed: boolean,
    ip: string,
    status: number,
    remaining: number
  ): void {
    const now = Date.now();

    // Update counters
    this.totalRequests++;
    if (allowed) {
      this.allowedRequests++;
    } else {
      this.blockedRequests++;
    }

    // Update per-endpoint stats
    if (!this.endpointStats.has(endpoint)) {
      this.endpointStats.set(endpoint, { total: 0, allowed: 0, blocked: 0 });
    }
    const stats = this.endpointStats.get(endpoint)!;
    stats.total++;
    if (allowed) {
      stats.allowed++;
    } else {
      stats.blocked++;
    }

    // Track active IP
    this.activeIPsSet.set(ip, { ip, lastSeen: now });

    // Record for req/s calculation
    this.requestHistory.push({ timestamp: now, endpoint, allowed });

    // Track recent requests for dashboard table
    this.recentRequests.unshift({
      timestamp: now,
      ip: ip.substring(0, 12) + "...", // Truncate for privacy
      endpoint,
      status,
      remaining,
    });
    if (this.recentRequests.length > this.MAX_RECENT_REQUESTS) {
      this.recentRequests.pop();
    }

    // Cleanup old data (prevent memory leaks)
    this.cleanupStaleData(now);
  }

  /**
   * Get current metrics snapshot.
   *
   * WHY: The /api/metrics endpoint calls this to return JSON.
   * Dashboard polls that endpoint every few seconds.
   */
  getSnapshot(): MetricsSnapshot {
    const now = Date.now();
    this.cleanupStaleData(now);

    return {
      total: this.totalRequests,
      allowed: this.allowedRequests,
      blocked: this.blockedRequests,
      activeIPs: this.activeIPsSet.size,
      requestsPerSecond: this.calculateRequestsPerSecond(now),
      endpoints: Object.fromEntries(this.endpointStats),
      recentRequests: this.recentRequests,
    };
  }

  /**
   * Calculate requests per second over the last minute.
   *
   * WHY: Shows current traffic intensity. Uses a rolling window
   * to smooth out spikes.
   */
  private calculateRequestsPerSecond(now: number): number {
    const windowStart = now - this.HISTORY_WINDOW;
    const recentCount = this.requestHistory.filter(
      (r) => r.timestamp >= windowStart
    ).length;
    return parseFloat((recentCount / (this.HISTORY_WINDOW / 1000)).toFixed(2));
  }

  /**
   * Remove stale IPs and old request records.
   *
   * WHY: Without this, the Set and array grow forever (memory leak).
   * We only care about recent activity.
   */
  private cleanupStaleData(now: number): void {
    // Remove IPs not seen in IP_TTL
    for (const [ip, entry] of this.activeIPsSet.entries()) {
      if (now - entry.lastSeen > this.IP_TTL) {
        this.activeIPsSet.delete(ip);
      }
    }

    // Remove request records older than HISTORY_WINDOW
    const windowStart = now - this.HISTORY_WINDOW;
    this.requestHistory = this.requestHistory.filter(
      (r) => r.timestamp >= windowStart
    );
  }

  /**
   * Reset all metrics (useful for testing or manual reset).
   */
  reset(): void {
    this.totalRequests = 0;
    this.allowedRequests = 0;
    this.blockedRequests = 0;
    this.endpointStats.clear();
    this.activeIPsSet.clear();
    this.requestHistory = [];
    this.recentRequests = [];
  }
}

// Singleton instance shared across middleware and metrics endpoint
export const metrics = new MetricsCollector();
