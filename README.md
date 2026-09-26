# API Rate Limiter

Last updated: 2026-09-26

Next.js rate limiter with a live dashboard. Middleware counts requests per issued API key or trusted IP, returns `429` when a limit is hit, and streams metrics to the UI.

[Use guide](docs/use-guide.md) · [Deployment guide](docs/deployment-guide.md) · [Project overview](PROJECT-OVERVIEW.md) · [Design notes](docs/rate-limiting.md)

## Run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Copy `.env.example` to `.env.local` and set:

- `ADMIN_RESET_KEY` — required for the dashboard, config, metrics, SSE, and Prometheus. There is no default.
- `ALLOW_UNTRUSTED_FORWARDED=1` — development only, so the simulator can send a fake `x-forwarded-for`.
- `API_KEYS` — comma-separated issued keys. Any other `X-API-Key` is ignored and the request is limited by IP.
- `TRUSTED_PROXY_HOPS` — addresses to take from the right of `x-forwarded-for`. `0` ignores forwarding headers.

The dashboard asks for the admin key, stores an httpOnly cookie, then opens the live stream. Use the simulator to fire `/api/ping` until you see `429`.

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

In-memory counters are the default. For multiple instances, set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Counters, bans, and live config are then shared. Fixed windows use `INCR` and `PEXPIRE` inside one `EVAL`. If Redis is configured and a command fails, the middleware returns `503`.

Without those variables, the app keeps using `MemoryStore`.

## Docker

```bash
docker compose up --build
```

Then open `http://localhost:3000`.

## Vercel

Deploy as a Next.js app. Serverless isolates do **not** share the in-memory store — set the Upstash variables if limits, bans, and config must stick across invocations. `experimental.nodeMiddleware` keeps middleware and route handlers in one Node process when you stay in-memory. `next` is pinned to `15.5.24`.

## HTTP surface

| Route | Role |
|---|---|
| `GET /api/ping` | 10/min demo |
| `POST /api/echo` | 5/min demo |
| `POST /api/contact` | 3/10min demo |
| `GET /api/metrics` | JSON snapshot (admin) |
| `GET /api/metrics/stream` | SSE snapshot (admin cookie) |
| `GET /api/metrics/prometheus` | OpenMetrics (admin) |
| `POST /api/metrics` | Reset (admin) |
| `GET/POST /api/config` | Live limits (admin) |
| `POST /api/admin/session` | Sets the admin cookie |
| `GET/POST /api/compare` | Isolated algorithm burst (`burst` max 100) |

Identity: an issued `X-API-Key` or `Authorization: Bearer` wins; otherwise the trusted IP. A missing identity is `400`, not a shared bucket. `X-RateLimit-Reset` is epoch milliseconds.
