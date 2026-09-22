/**
 * Metrics Collector — observability, SSE subscribers, audit log, Prometheus.
 */

export interface EndpointStats {
  total: number;
  allowed: number;
  blocked: number;
}

export interface AuditEntry {
  timestamp: number;
  identity: string;
  endpoint: string;
  retryAfter: number;
  reason: "rate_limit" | "ban" | "blocklist";
}

export interface MetricsSnapshot {
  total: number;
  allowed: number;
  blocked: number;
  banned: number;
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
  auditLog: AuditEntry[];
}

interface RequestRecord {
  timestamp: number;
  endpoint: string;
  allowed: boolean;
}

interface IPEntry {
  ip: string;
  lastSeen: number;
}

type Subscriber = (snapshot: MetricsSnapshot) => void;

export class MetricsCollector {
  private totalRequests = 0;
  private allowedRequests = 0;
  private blockedRequests = 0;
  private bannedRequests = 0;
  private endpointStats = new Map<string, EndpointStats>();
  private activeIPsSet = new Map<string, IPEntry>();
  private requestHistory: RequestRecord[] = [];
  private recentRequests: MetricsSnapshot["recentRequests"] = [];
  private auditLog: AuditEntry[] = [];
  private subscribers = new Set<Subscriber>();

  private readonly IP_TTL = 300_000;
  private readonly HISTORY_WINDOW = 60_000;
  private readonly MAX_RECENT_REQUESTS = 50;
  private readonly MAX_AUDIT = 100;

  recordRequest(
    endpoint: string,
    allowed: boolean,
    ip: string,
    status: number,
    remaining: number,
    extra?: { retryAfter?: number; reason?: AuditEntry["reason"] }
  ): void {
    const now = Date.now();

    this.totalRequests++;
    if (allowed) this.allowedRequests++;
    else this.blockedRequests++;
    if (extra?.reason === "ban") this.bannedRequests++;

    if (!this.endpointStats.has(endpoint)) {
      this.endpointStats.set(endpoint, { total: 0, allowed: 0, blocked: 0 });
    }
    const stats = this.endpointStats.get(endpoint)!;
    stats.total++;
    if (allowed) stats.allowed++;
    else stats.blocked++;

    this.activeIPsSet.set(ip, { ip, lastSeen: now });
    this.requestHistory.push({ timestamp: now, endpoint, allowed });

    this.recentRequests.unshift({
      timestamp: now,
      ip: ip.length > 14 ? `${ip.slice(0, 12)}…` : ip,
      endpoint,
      status,
      remaining,
    });
    if (this.recentRequests.length > this.MAX_RECENT_REQUESTS) {
      this.recentRequests.pop();
    }

    if (!allowed) {
      this.auditLog.unshift({
        timestamp: now,
        identity: ip.length > 14 ? `${ip.slice(0, 12)}…` : ip,
        endpoint,
        retryAfter: extra?.retryAfter ?? 0,
        reason: extra?.reason ?? "rate_limit",
      });
      if (this.auditLog.length > this.MAX_AUDIT) this.auditLog.pop();
    }

    this.cleanupStaleData(now);
    this.emit();
  }

  getSnapshot(): MetricsSnapshot {
    const now = Date.now();
    this.cleanupStaleData(now);
    return {
      total: this.totalRequests,
      allowed: this.allowedRequests,
      blocked: this.blockedRequests,
      banned: this.bannedRequests,
      activeIPs: this.activeIPsSet.size,
      requestsPerSecond: this.calculateRequestsPerSecond(now),
      endpoints: Object.fromEntries(this.endpointStats),
      recentRequests: this.recentRequests,
      auditLog: this.auditLog,
    };
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    fn(this.getSnapshot());
    return () => {
      this.subscribers.delete(fn);
    };
  }

  toPrometheus(): string {
    const snap = this.getSnapshot();
    const lines: string[] = [
      "# HELP rate_limit_requests_total Requests seen by the limiter",
      "# TYPE rate_limit_requests_total counter",
      `rate_limit_requests_total{result="allowed"} ${snap.allowed}`,
      `rate_limit_requests_total{result="blocked"} ${snap.blocked}`,
      `rate_limit_requests_total{result="banned"} ${snap.banned}`,
      "# HELP rate_limit_requests_per_endpoint_total Requests by endpoint",
      "# TYPE rate_limit_requests_per_endpoint_total counter",
    ];
    for (const [name, stats] of Object.entries(snap.endpoints)) {
      const ep = sanitizeLabel(name);
      lines.push(
        `rate_limit_requests_per_endpoint_total{endpoint="${ep}",result="allowed"} ${stats.allowed}`
      );
      lines.push(
        `rate_limit_requests_per_endpoint_total{endpoint="${ep}",result="blocked"} ${stats.blocked}`
      );
    }
    lines.push("# EOF");
    return lines.join("\n") + "\n";
  }

  reset(): void {
    this.totalRequests = 0;
    this.allowedRequests = 0;
    this.blockedRequests = 0;
    this.bannedRequests = 0;
    this.endpointStats.clear();
    this.activeIPsSet.clear();
    this.requestHistory = [];
    this.recentRequests = [];
    this.auditLog = [];
    this.emit();
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const fn of this.subscribers) {
      try {
        fn(snap);
      } catch (err) {
        console.error("[metrics] subscriber error", err);
      }
    }
  }

  private calculateRequestsPerSecond(now: number): number {
    const windowStart = now - this.HISTORY_WINDOW;
    const recent = this.requestHistory.filter((r) => r.timestamp >= windowStart);
    const elapsedMs = Math.min(
      this.HISTORY_WINDOW,
      now - (recent[0]?.timestamp ?? now)
    );
    const elapsedSec = Math.max(1, elapsedMs / 1000);
    return parseFloat((recent.length / elapsedSec).toFixed(2));
  }

  private cleanupStaleData(now: number): void {
    for (const [ip, entry] of this.activeIPsSet.entries()) {
      if (now - entry.lastSeen > this.IP_TTL) this.activeIPsSet.delete(ip);
    }
    const windowStart = now - this.HISTORY_WINDOW;
    this.requestHistory = this.requestHistory.filter(
      (r) => r.timestamp >= windowStart
    );
  }
}

function sanitizeLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9_:-]/g, "_");
}

declare global {
  // eslint-disable-next-line no-var
  var __rateLimitMetrics: MetricsCollector | undefined;
}

export const metrics =
  globalThis.__rateLimitMetrics ??
  (globalThis.__rateLimitMetrics = new MetricsCollector());
