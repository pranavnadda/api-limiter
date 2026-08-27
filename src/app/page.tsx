'use client';

/**
 * Dashboard — Rate Limiter Observability UI
 *
 * WHY THIS FILE:
 * Phase 2 turns raw metrics (JSON from /api/metrics) into a live dashboard.
 * Users can visually see rate limiting in action without curl.
 *
 * DESIGN CHOICES:
 * - Client-side component (use client) so we can useEffect to poll metrics
 * - Polls /api/metrics every 2 seconds to keep data fresh
 * - Fail-open: if metrics endpoint is down, shows "Connecting..." instead of crashing
 * - Recharts for charts (standard React charting library, works with Next.js 15)
 * - Three sections: stats cards, requests/sec chart, endpoint table, recent requests
 */

import { useEffect, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
} from 'recharts';

interface MetricsSnapshot {
  total: number;
  allowed: number;
  blocked: number;
  activeIPs: number;
  requestsPerSecond: number;
  endpoints: Record<string, { total: number; allowed: number; blocked: number }>;
  recentRequests: Array<{
    timestamp: number;
    ip: string;
    endpoint: string;
    status: number;
    remaining: number;
  }>;
}

/**
 * STAT CARD COMPONENT
 * WHY: Reusable card for displaying a single metric (total, allowed, blocked, IPs).
 * Keeps the dashboard grid DRY and readable.
 */
function StatCard({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div
      style={{
        padding: '1rem',
        border: `2px solid ${color}`,
        borderRadius: '0.5rem',
        textAlign: 'center',
        minWidth: '150px',
      }}
    >
      <div style={{ fontSize: '0.9rem', color: '#666', marginBottom: '0.5rem' }}>
        {label}
      </div>
      <div style={{ fontSize: '2rem', fontWeight: 'bold', color }}>{value}</div>
    </div>
  );
}

export default function Dashboard() {
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chartData, setChartData] = useState<Array<{ time: string; rps: number }>>([]);

  /**
   * WHY THIS EFFECT:
   * - Polls /api/metrics every 2 seconds to keep dashboard live
   * - On success: updates metrics state and adds data point to chart
   * - On error: sets error state but doesn't crash (fail-open)
   * - Cleanup: clears interval on unmount to prevent memory leaks
   */
  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const res = await fetch('/api/metrics');
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();
        setMetrics(data.data);
        setError(null);
        setLoading(false);

        // WHY: Keep last 30 data points for the chart (sliding window).
        // Older points drop off so the chart doesn't grow infinitely.
        setChartData((prev) => {
          const time = new Date().toLocaleTimeString();
          const newData = [...prev, { time, rps: data.data.requestsPerSecond }];
          return newData.slice(-30);
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
        setLoading(false);
      }
    };

    // Fetch immediately, then every 2 seconds.
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 2000);
    return () => clearInterval(interval);
  }, []);

  // WHY: Show a loading state while first metrics fetch is in progress.
  if (loading) {
    return (
      <main style={{ padding: '2rem', fontFamily: 'monospace' }}>
        <h1>📊 Rate Limiter Dashboard</h1>
        <p>Connecting to metrics endpoint...</p>
      </main>
    );
  }

  // WHY: Fail-open — if metrics endpoint is unreachable, show error message
  // instead of blank page. User knows what to check.
  if (error || !metrics) {
    return (
      <main style={{ padding: '2rem', fontFamily: 'monospace' }}>
        <h1>📊 Rate Limiter Dashboard</h1>
        <div style={{ color: '#d32f2f', marginTop: '1rem' }}>
          <p>⚠️ Metrics endpoint unreachable: {error}</p>
          <p>Make sure the dev server is running with: <code>npm run dev</code></p>
        </div>
      </main>
    );
  }

  // WHY: Calculate blocked percentage for insight into rate limit effectiveness.
  const blockedPercent = metrics.total > 0 ? ((metrics.blocked / metrics.total) * 100).toFixed(1) : '0';

  // WHY: Transform endpoint stats into chart-friendly format.
  // Recharts expects array of objects with same keys.
  const endpointChartData = Object.entries(metrics.endpoints).map(([name, stats]) => ({
    name,
    blocked: stats.blocked,
    allowed: stats.allowed,
  }));

  return (
    <main style={{ padding: '2rem', fontFamily: 'monospace', maxWidth: '1200px', margin: '0 auto' }}>
      <h1>📊 Rate Limiter Dashboard</h1>
      <p style={{ color: '#666', marginBottom: '2rem' }}>
        Live metrics from rate limiter. Updates every 2 seconds.
      </p>

      {/* STATS CARDS SECTION */}
      {/* WHY: Show key metrics at a glance. Color-coded for quick visual scanning. */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem', flexWrap: 'wrap' }}>
        <StatCard label="Total Requests" value={metrics.total} color="#1976d2" />
        <StatCard label="Allowed" value={metrics.allowed} color="#388e3c" />
        <StatCard label="Blocked (429)" value={metrics.blocked} color="#d32f2f" />
        <StatCard label="Active IPs" value={metrics.activeIPs} color="#f57c00" />
      </div>

      {/* STATS ROW 2 */}
      {/* WHY: Secondary metrics — blocked percentage and requests/second give operational insight. */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem', flexWrap: 'wrap' }}>
        <StatCard label="Blocked %" value={`${blockedPercent}%`} color="#9c27b0" />
        <StatCard label="Req/sec (rolling)" value={metrics.requestsPerSecond.toFixed(2)} color="#00897b" />
      </div>

      {/* REQUESTS/SECOND CHART */}
      {/* WHY: Time-series line chart shows traffic intensity over last ~1 minute.
          Useful for spotting spikes or sustained high load. */}
      <div style={{ marginBottom: '2rem', padding: '1rem', border: '1px solid #ddd', borderRadius: '0.5rem' }}>
        <h2>Requests per Second (Last ~1 min)</h2>
        {chartData.length > 1 ? (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 12 }}
                interval={Math.max(0, Math.floor(chartData.length / 5))}
              />
              <YAxis />
              <Tooltip />
              <Line
                type="monotone"
                dataKey="rps"
                stroke="#1976d2"
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p style={{ color: '#999' }}>Waiting for data points...</p>
        )}
      </div>

      {/* PER-ENDPOINT STATS TABLE */}
      {/* WHY: Show which endpoints are getting hit hardest and how many are blocked.
          Helps identify which endpoints might need stricter/looser limits. */}
      <div style={{ marginBottom: '2rem', padding: '1rem', border: '1px solid #ddd', borderRadius: '0.5rem' }}>
        <h2>Per-Endpoint Breakdown</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #ddd' }}>
              <th style={{ padding: '0.5rem', textAlign: 'left' }}>Endpoint</th>
              <th style={{ padding: '0.5rem', textAlign: 'center' }}>Total</th>
              <th style={{ padding: '0.5rem', textAlign: 'center' }}>Allowed</th>
              <th style={{ padding: '0.5rem', textAlign: 'center' }}>Blocked</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(metrics.endpoints).map(([name, stats]) => (
              <tr key={name} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '0.5rem' }}>
                  <code>{name}</code>
                </td>
                <td style={{ padding: '0.5rem', textAlign: 'center' }}>{stats.total}</td>
                <td style={{ padding: '0.5rem', textAlign: 'center', color: '#388e3c' }}>
                  {stats.allowed}
                </td>
                <td style={{ padding: '0.5rem', textAlign: 'center', color: '#d32f2f' }}>
                  {stats.blocked}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* BLOCKED vs ALLOWED BAR CHART */}
      {/* WHY: Visual comparison across endpoints — which ones get blocked the most?
          Helps identify abuse patterns or misconfigured limits. */}
      {endpointChartData.length > 0 && (
        <div style={{ marginBottom: '2rem', padding: '1rem', border: '1px solid #ddd', borderRadius: '0.5rem' }}>
          <h2>Blocked vs Allowed by Endpoint</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={endpointChartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" />
              <YAxis />
              <Tooltip />
              <Bar dataKey="allowed" stackId="a" fill="#388e3c" />
              <Bar dataKey="blocked" stackId="a" fill="#d32f2f" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* RECENT REQUESTS TABLE */}
      {/* WHY: Show last 50 requests in order. Helps debug:
          - Identify which IPs are being blocked most
          - See real-time request flow
          - Verify rate limit logic is working correctly */}
      <div style={{ marginBottom: '2rem', padding: '1rem', border: '1px solid #ddd', borderRadius: '0.5rem' }}>
        <h2>Recent Requests (Last 50)</h2>
        {metrics.recentRequests.length > 0 ? (
          <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
              <thead style={{ position: 'sticky', top: 0, backgroundColor: '#f5f5f5' }}>
                <tr style={{ borderBottom: '2px solid #ddd' }}>
                  <th style={{ padding: '0.5rem', textAlign: 'left' }}>Time</th>
                  <th style={{ padding: '0.5rem', textAlign: 'left' }}>IP</th>
                  <th style={{ padding: '0.5rem', textAlign: 'left' }}>Endpoint</th>
                  <th style={{ padding: '0.5rem', textAlign: 'center' }}>Status</th>
                  <th style={{ padding: '0.5rem', textAlign: 'center' }}>Remaining</th>
                </tr>
              </thead>
              <tbody>
                {metrics.recentRequests.map((req, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: '0.5rem' }}>
                      {new Date(req.timestamp).toLocaleTimeString()}
                    </td>
                    <td style={{ padding: '0.5rem' }}>
                      <code style={{ fontSize: '0.85rem' }}>{req.ip}</code>
                    </td>
                    <td style={{ padding: '0.5rem' }}>
                      <code>{req.endpoint}</code>
                    </td>
                    <td
                      style={{
                        padding: '0.5rem',
                        textAlign: 'center',
                        color: req.status === 200 ? '#388e3c' : '#d32f2f',
                        fontWeight: 'bold',
                      }}
                    >
                      {req.status}
                    </td>
                    <td style={{ padding: '0.5rem', textAlign: 'center' }}>{req.remaining}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p style={{ color: '#999' }}>No requests recorded yet. Try hitting an endpoint!</p>
        )}
      </div>

      {/* TESTING INSTRUCTIONS */}
      {/* WHY: Keep instructions visible on dashboard so users know what to test. */}
      <div style={{ padding: '1rem', backgroundColor: '#f5f5f5', borderRadius: '0.5rem', marginTop: '2rem' }}>
        <h3>🧪 Quick Test</h3>
        <p>Open a terminal and run:</p>
        <pre style={{ backgroundColor: '#fff', padding: '1rem', overflow: 'auto' }}>
{`# Make 11 requests to ping (limit is 10/min)
for i in {1..11}; do
  echo "Request $i:"
  curl -i http://localhost:3000/api/ping
  echo ""
done

# Watch the dashboard — you'll see:
# - Total requests increment
# - Request 11 returns 429 (blocked)
# - Blocked count increases
# - 'Remaining' column shows 0 on blocked requests`}
        </pre>
      </div>
    </main>
  );
}
