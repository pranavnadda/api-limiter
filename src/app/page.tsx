'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MetricsSnapshot } from '@/lib/rate-limit/metrics';
import type { ConfigSnapshot } from '@/lib/rate-limit/config-store';
import type { CompareResult } from '@/lib/rate-limit/compare';
import type { RateLimitAlgorithm } from '@/lib/rate-limit/types';

const ADMIN_STORAGE = 'api-limiter-admin-key';

function unwrap<T>(payload: { data?: T } | T): T {
  if (payload && typeof payload === 'object' && 'data' in payload && payload.data) {
    return payload.data as T;
  }
  return payload as T;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export default function Dashboard() {
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [config, setConfig] = useState<ConfigSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);
  const [chartData, setChartData] = useState<Array<{ time: string; rps: number }>>([]);
  const [adminKey, setAdminKey] = useState('demo-reset-key');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [simLog, setSimLog] = useState<string[]>([]);
  const [sim, setSim] = useState({
    endpoint: 'ping',
    count: 12,
    delay: 80,
    ip: '',
    apiKey: '',
  });
  const [compare, setCompare] = useState<CompareResult | null>(null);
  const [auditFilter, setAuditFilter] = useState('all');
  const [lists, setLists] = useState({ allowlist: '', blocklist: '' });

  useEffect(() => {
    const stored = localStorage.getItem(ADMIN_STORAGE);
    if (stored) setAdminKey(stored);
  }, []);

  const applyMetrics = useCallback((data: MetricsSnapshot) => {
    setMetrics(data);
    setError(null);
    setLoading(false);
    setChartData((prev) => {
      const time = new Date().toLocaleTimeString();
      return [...prev, { time, rps: data.requestsPerSecond ?? 0 }].slice(-30);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | undefined;

    const loadConfig = async () => {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error(`Config ${res.status}`);
      const payload = unwrap<ConfigSnapshot>(await res.json());
      if (!cancelled) {
        setConfig(payload);
        setLists({
          allowlist: payload.allowlist.join('\n'),
          blocklist: payload.blocklist.join('\n'),
        });
      }
    };

    const pollMetrics = async () => {
      const res = await fetch('/api/metrics');
      if (!res.ok) throw new Error(`Metrics ${res.status}`);
      const payload = unwrap<MetricsSnapshot>(await res.json());
      if (!cancelled) applyMetrics(payload);
    };

    const start = async () => {
      try {
        await Promise.all([loadConfig(), pollMetrics()]);
        source = new EventSource('/api/metrics/stream');
        source.onmessage = (ev) => {
          try {
            applyMetrics(JSON.parse(ev.data) as MetricsSnapshot);
            setLive(true);
          } catch {
            /* ignore parse blips */
          }
        };
        source.onerror = () => {
          setLive(false);
          source?.close();
          source = null;
          if (!poll) poll = setInterval(() => void pollMetrics().catch(() => {}), 2000);
        };
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to load dashboard');
          setLoading(false);
        }
      }
    };

    void start();
    return () => {
      cancelled = true;
      source?.close();
      if (poll) clearInterval(poll);
    };
  }, [applyMetrics]);

  const adminHeaders = useMemo(
    () => ({ 'Content-Type': 'application/json', 'X-Admin-Reset': adminKey }),
    [adminKey]
  );

  async function resetMetrics() {
    setBusy('reset');
    localStorage.setItem(ADMIN_STORAGE, adminKey);
    const res = await fetch('/api/metrics', { method: 'POST', headers: adminHeaders });
    setBusy(null);
    setNotice(res.ok ? 'Metrics reset.' : 'Reset failed — check the admin key.');
  }

  async function saveEndpoint(
    endpoint: string,
    patch: {
      limit: number;
      windowMs: number;
      algorithm: RateLimitAlgorithm;
      refillRate?: number;
      extraLimit?: number;
      extraWindowMs?: number;
    }
  ) {
    setBusy(endpoint);
    localStorage.setItem(ADMIN_STORAGE, adminKey);
    const windows =
      patch.extraLimit && patch.extraWindowMs
        ? [{ limit: patch.extraLimit, windowMs: patch.extraWindowMs }]
        : null;
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        endpoint,
        limit: patch.limit,
        windowMs: patch.windowMs,
        algorithm: patch.algorithm,
        refillRate: patch.refillRate,
        windows,
      }),
    });
    setBusy(null);
    if (!res.ok) {
      setNotice('Could not save limits — check the admin key.');
      return;
    }
    setConfig(unwrap<ConfigSnapshot>(await res.json()));
    setNotice(`Updated ${endpoint} limits.`);
  }

  async function saveLists(event: FormEvent) {
    event.preventDefault();
    setBusy('lists');
    localStorage.setItem(ADMIN_STORAGE, adminKey);
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        allowlist: lists.allowlist.split('\n').map((s) => s.trim()).filter(Boolean),
        blocklist: lists.blocklist.split('\n').map((s) => s.trim()).filter(Boolean),
      }),
    });
    setBusy(null);
    if (!res.ok) {
      setNotice('Could not save lists — check the admin key.');
      return;
    }
    setConfig(unwrap<ConfigSnapshot>(await res.json()));
    setNotice('Allow/block lists saved.');
  }

  async function runCompare() {
    setBusy('compare');
    const res = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 10, windowMs: 60_000, burst: 16 }),
    });
    setBusy(null);
    if (!res.ok) {
      setNotice('Comparison failed.');
      return;
    }
    setCompare(unwrap<CompareResult>(await res.json()));
  }

  async function runSimulator() {
    setBusy('sim');
    setSimLog([]);
    const lines: string[] = [];
    for (let i = 1; i <= sim.count; i++) {
      const headers: Record<string, string> = {};
      if (sim.ip) headers['x-forwarded-for'] = sim.ip;
      if (sim.apiKey) headers['x-api-key'] = sim.apiKey;
      const init: RequestInit = { method: 'GET', headers };
      if (sim.endpoint === 'echo') {
        init.method = 'POST';
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify({ n: i });
      }
      if (sim.endpoint === 'contact') {
        init.method = 'POST';
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify({
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          message: 'Dashboard simulator message that meets the length rule.',
        });
      }
      try {
        const res = await fetch(`/api/${sim.endpoint}`, init);
        const remaining = res.headers.get('x-ratelimit-remaining') ?? '—';
        const line = `#${i} ${res.status} remaining ${remaining}`;
        lines.push(line);
        setSimLog([...lines]);
      } catch (err) {
        lines.push(`#${i} failed: ${err instanceof Error ? err.message : 'error'}`);
        setSimLog([...lines]);
      }
      if (sim.delay) await sleep(sim.delay);
    }
    setBusy(null);
  }

  if (loading) {
    return (
      <main className="app-shell">
        <h1>Rate limiter</h1>
        <div className="skel" style={{ width: '40%' }} />
        <div className="skel" />
        <div className="skel" />
      </main>
    );
  }

  if (error || !metrics) {
    return (
      <main className="app-shell">
        <h1>Rate limiter</h1>
        <div className="banner">
          Metrics endpoint unreachable: {error}. Start the app with npm run dev.
        </div>
      </main>
    );
  }

  const blockedPercent =
    metrics.total > 0 ? ((metrics.blocked / metrics.total) * 100).toFixed(1) : '0';
  const alert = metrics.total >= 8 && Number(blockedPercent) >= 30;
  const endpointChartData = Object.entries(metrics.endpoints).map(([name, stats]) => ({
    name,
    blocked: stats.blocked,
    allowed: stats.allowed,
  }));
  const compareChart = compare
    ? compare.series['fixed-window'].map((point, i) => ({
        i: point.index,
        fixed: point.remaining,
        token: compare.series['token-bucket'][i]?.remaining ?? 0,
        sliding: compare.series['sliding-window'][i]?.remaining ?? 0,
      }))
    : [];
  const audit = metrics.auditLog.filter((row) =>
    auditFilter === 'all' ? true : row.reason === auditFilter
  );

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>Rate limiter</h1>
          <p>
            Hit an endpoint from the simulator. Limits, bans, and identity keys all feed this
            board. Prometheus is at /api/metrics/prometheus.
          </p>
        </div>
        <div className="toolbar">
          <span className={`live-dot ${live ? '' : 'stale'}`}>
            <i />
            {live ? 'Live stream' : 'Polling'}
          </span>
          <label className="field" style={{ minWidth: 180 }}>
            <span>Admin key</span>
            <input
              type="password"
              value={adminKey}
              onChange={(e) => setAdminKey(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button className="btn btn-danger" onClick={() => void resetMetrics()} disabled={busy === 'reset'}>
            Reset metrics
          </button>
        </div>
      </header>

      {alert && (
        <div className="banner">
          Block rate is {blockedPercent}% — more than 30% of traffic is being rejected.
        </div>
      )}
      {notice && <div className="banner ok">{notice}</div>}

      <section className="strip" aria-label="Current totals">
        <article>
          <dt>Total</dt>
          <dd>{metrics.total}</dd>
        </article>
        <article>
          <dt>Allowed</dt>
          <dd className="ok">{metrics.allowed}</dd>
        </article>
        <article>
          <dt>Blocked</dt>
          <dd className="bad">{metrics.blocked}</dd>
        </article>
        <article>
          <dt>Banned</dt>
          <dd>{metrics.banned}</dd>
        </article>
        <article>
          <dt>Active identities</dt>
          <dd>{metrics.activeIPs}</dd>
        </article>
        <article>
          <dt>Req/s</dt>
          <dd>{metrics.requestsPerSecond.toFixed(2)}</dd>
        </article>
      </section>

      <div className="grid-2">
        <section className="panel">
          <h2>Simulator</h2>
          <div className="controls">
            <label className="field">
              <span>Endpoint</span>
              <select
                value={sim.endpoint}
                onChange={(e) => setSim({ ...sim, endpoint: e.target.value })}
              >
                <option value="ping">GET /api/ping</option>
                <option value="echo">POST /api/echo</option>
                <option value="contact">POST /api/contact</option>
              </select>
            </label>
            <label className="field">
              <span>Count</span>
              <input
                type="number"
                min={1}
                max={100}
                value={sim.count}
                onChange={(e) => setSim({ ...sim, count: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>Delay (ms)</span>
              <input
                type="number"
                min={0}
                value={sim.delay}
                onChange={(e) => setSim({ ...sim, delay: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>Fake IP (x-forwarded-for)</span>
              <input
                value={sim.ip}
                onChange={(e) => setSim({ ...sim, ip: e.target.value })}
                placeholder="203.0.113.4"
              />
            </label>
            <label className="field">
              <span>API key</span>
              <input
                value={sim.apiKey}
                onChange={(e) => setSim({ ...sim, apiKey: e.target.value })}
                placeholder="optional X-API-Key"
              />
            </label>
          </div>
          <button className="btn btn-primary" onClick={() => void runSimulator()} disabled={busy === 'sim'}>
            {busy === 'sim' ? 'Sending…' : `Send ${sim.count} requests`}
          </button>
          <div className="log" style={{ marginTop: 12 }}>
            {simLog.length === 0 ? (
              <p className="empty">Run a burst to watch remaining drop, then 429.</p>
            ) : (
              simLog.map((line, idx) => (
                <div key={`${idx}-${line}`} className={line.includes('429') || line.includes('403') ? 'miss' : 'hit'}>
                  {line}
                </div>
              ))
            )}
          </div>
        </section>

        <section className="panel">
          <h2>Live limits</h2>
          <p className="muted">Changes apply immediately. Require the admin key.</p>
          {config &&
            Object.entries(config.endpoints).map(([name, cfg]) => (
              <EndpointEditor
                key={name}
                name={name}
                config={cfg}
                busy={busy === name}
                onSave={(patch) => void saveEndpoint(name, patch)}
              />
            ))}
        </section>
      </div>

      <div className="grid-2">
        <section className="panel">
          <h2>Requests per second</h2>
          <div className="chart-box">
            {chartData.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid stroke="#2c3326" />
                  <XAxis dataKey="time" stroke="#b7b19f" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#b7b19f" tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: '#1a1f16', border: '1px solid #2c3326' }} />
                  <Line type="monotone" dataKey="rps" stroke="#c4d35a" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="empty">Waiting for a second sample.</p>
            )}
          </div>
        </section>
        <section className="panel">
          <h2>Allowed vs blocked</h2>
          <div className="chart-box">
            {endpointChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={endpointChartData}>
                  <CartesianGrid stroke="#2c3326" />
                  <XAxis dataKey="name" stroke="#b7b19f" />
                  <YAxis stroke="#b7b19f" />
                  <Tooltip contentStyle={{ background: '#1a1f16', border: '1px solid #2c3326' }} />
                  <Bar dataKey="allowed" stackId="a" fill="#7ecf9a" />
                  <Bar dataKey="blocked" stackId="a" fill="#e25b3a" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="empty">No endpoint traffic yet. Use the simulator.</p>
            )}
          </div>
        </section>
      </div>

      <div className="grid-2">
        <section className="panel">
          <h2>Recent requests</h2>
          {metrics.recentRequests.length === 0 ? (
            <p className="empty">Nothing recorded yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Identity</th>
                    <th>Endpoint</th>
                    <th>Status</th>
                    <th>Left</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.recentRequests.map((row, idx) => (
                    <tr key={`${row.timestamp}-${idx}`}>
                      <td>{new Date(row.timestamp).toLocaleTimeString()}</td>
                      <td>
                        <code>{row.ip}</code>
                      </td>
                      <td>
                        <code>{row.endpoint}</code>
                      </td>
                      <td className={row.status === 200 ? 'status-ok' : 'status-bad'}>{row.status}</td>
                      <td>{row.remaining}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <h2>Blocked audit</h2>
          <label className="field" style={{ maxWidth: 220, marginBottom: 10 }}>
            <span>Reason</span>
            <select value={auditFilter} onChange={(e) => setAuditFilter(e.target.value)}>
              <option value="all">All</option>
              <option value="rate_limit">Rate limit</option>
              <option value="ban">Ban</option>
              <option value="blocklist">Blocklist</option>
            </select>
          </label>
          {audit.length === 0 ? (
            <p className="empty">No blocked events in this filter.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Identity</th>
                    <th>Endpoint</th>
                    <th>Reason</th>
                    <th>Retry</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((row, idx) => (
                    <tr key={`${row.timestamp}-${idx}`}>
                      <td>{new Date(row.timestamp).toLocaleTimeString()}</td>
                      <td>
                        <code>{row.identity}</code>
                      </td>
                      <td>
                        <code>{row.endpoint}</code>
                      </td>
                      <td>{row.reason}</td>
                      <td>{row.retryAfter}s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <div className="grid-2">
        <section className="panel">
          <h2>Allowlist and blocklist</h2>
          <p className="muted">One identity or IP per line. Allowlist skips limits; blocklist returns 403.</p>
          <form onSubmit={(e) => void saveLists(e)} className="controls">
            <label className="field">
              <span>Allowlist</span>
              <textarea
                rows={5}
                value={lists.allowlist}
                onChange={(e) => setLists({ ...lists, allowlist: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Blocklist</span>
              <textarea
                rows={5}
                value={lists.blocklist}
                onChange={(e) => setLists({ ...lists, blocklist: e.target.value })}
              />
            </label>
            <button className="btn" type="submit" disabled={busy === 'lists'}>
              Save lists
            </button>
          </form>
        </section>

        <section className="panel">
          <h2>Algorithm comparison</h2>
          <p className="muted">
            Same burst, isolated stores, fake clock across a window boundary. Live counters are not
            touched.
          </p>
          <button className="btn btn-primary" onClick={() => void runCompare()} disabled={busy === 'compare'}>
            Run comparison
          </button>
          <div className="chart-box" style={{ marginTop: 12 }}>
            {compareChart.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={compareChart}>
                  <CartesianGrid stroke="#2c3326" />
                  <XAxis dataKey="i" stroke="#b7b19f" />
                  <YAxis stroke="#b7b19f" />
                  <Tooltip contentStyle={{ background: '#1a1f16', border: '1px solid #2c3326' }} />
                  <Line dataKey="fixed" stroke="#c4d35a" dot={false} isAnimationActive={false} />
                  <Line dataKey="token" stroke="#7ecf9a" dot={false} isAnimationActive={false} />
                  <Line dataKey="sliding" stroke="#e0b05a" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="empty">Run a comparison to plot remaining tokens.</p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function EndpointEditor({
  name,
  config,
  busy,
  onSave,
}: {
  name: string;
  config: ConfigSnapshot['endpoints'][string];
  busy: boolean;
  onSave: (patch: {
    limit: number;
    windowMs: number;
    algorithm: RateLimitAlgorithm;
    refillRate?: number;
    extraLimit?: number;
    extraWindowMs?: number;
  }) => void;
}) {
  const extra = config.windows?.[0];
  const [limit, setLimit] = useState(config.limit);
  const [windowMs, setWindowMs] = useState(config.windowMs);
  const [algorithm, setAlgorithm] = useState<RateLimitAlgorithm>(config.algorithm);
  const [extraLimit, setExtraLimit] = useState(extra?.limit ?? 0);
  const [extraWindowMs, setExtraWindowMs] = useState(extra?.windowMs ?? 0);

  useEffect(() => {
    setLimit(config.limit);
    setWindowMs(config.windowMs);
    setAlgorithm(config.algorithm);
    setExtraLimit(config.windows?.[0]?.limit ?? 0);
    setExtraWindowMs(config.windows?.[0]?.windowMs ?? 0);
  }, [config]);

  return (
    <div className="endpoint-card">
      <label className="field">
        <span>{name} limit</span>
        <input type="number" min={1} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
      </label>
      <label className="field">
        <span>Window ms</span>
        <input
          type="number"
          min={100}
          value={windowMs}
          onChange={(e) => setWindowMs(Number(e.target.value))}
        />
      </label>
      <label className="field">
        <span>Algorithm</span>
        <select value={algorithm} onChange={(e) => setAlgorithm(e.target.value as RateLimitAlgorithm)}>
          <option value="fixed-window">Fixed window</option>
          <option value="token-bucket">Token bucket</option>
          <option value="sliding-window">Sliding window</option>
        </select>
      </label>
      <button
        className="btn"
        disabled={busy}
        onClick={() =>
          onSave({
            limit,
            windowMs,
            algorithm,
            extraLimit: extraLimit || undefined,
            extraWindowMs: extraWindowMs || undefined,
          })
        }
      >
        Save
      </button>
      <label className="field">
        <span>2nd window limit (optional)</span>
        <input
          type="number"
          min={0}
          value={extraLimit}
          onChange={(e) => setExtraLimit(Number(e.target.value))}
        />
      </label>
      <label className="field">
        <span>2nd window ms</span>
        <input
          type="number"
          min={0}
          value={extraWindowMs}
          onChange={(e) => setExtraWindowMs(Number(e.target.value))}
        />
      </label>
    </div>
  );
}
