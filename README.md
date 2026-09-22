# API Rate Limiter

Next.js rate limiter with a live dashboard. Middleware counts requests per IP or API key, returns `429` when a limit is hit, and streams metrics to the UI.

[Project overview](PROJECT-OVERVIEW.md) · [Design notes](docs/rate-limiting.md)

## Run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Use the simulator to fire `/api/ping` until you see `429`. Admin mutations (reset, live limits, lists) use header `X-Admin-Reset`. Default demo key: `demo-reset-key`. Set `ADMIN_RESET_KEY` in production.

```bash
npm test
npm run build
```

## Demo without curl

1. Set count to something above the ping limit (default 10/min).
2. Click **Send requests**. Remaining drops, then `429`.
3. Switch algorithm on ping (fixed window / token bucket / sliding window) and run again.
4. **Reset metrics** to start a clean demo.

## Redis (optional)

In-memory counters are the default. For multiple instances or Vercel, set:

```
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

Without those, the app keeps using `MemoryStore`.

## Docker

```bash
docker compose up --build
```

Then open `http://localhost:3000`.

## Vercel

Deploy as a Next.js app. Serverless isolates do **not** share the in-memory store — use Upstash Redis if you need limits to stick across invocations. `experimental.nodeMiddleware` is required so middleware and route handlers share process state when you stay in-memory.

## HTTP surface

| Route | Role |
|---|---|
| `GET /api/ping` | 10/min demo |
| `POST /api/echo` | 5/min demo |
| `POST /api/contact` | 3/10min demo |
| `GET /api/metrics` | JSON snapshot |
| `GET /api/metrics/stream` | SSE snapshot |
| `GET /api/metrics/prometheus` | OpenMetrics |
| `POST /api/metrics` | Reset (admin) |
| `GET/POST /api/config` | Live limits (POST is admin) |
| `GET/POST /api/compare` | Isolated algorithm burst |

Identity: `X-API-Key` or `Authorization: Bearer` wins; otherwise `x-forwarded-for` / `x-real-ip`.
