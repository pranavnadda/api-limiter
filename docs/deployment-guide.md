# Deployment guide

Last updated: 2026-09-26

How to put the rate limiter where someone can open it, and how to check that it is actually limiting. Day-to-day clicking is in [use-guide.md](use-guide.md).

## Decide three things first

You need these answers before the app is useful to anyone else.

**An admin key.** This is the password for the dashboard: viewing numbers, changing limits, and resetting the board. Pick a long random string and keep it. The app will not invent one. If `ADMIN_RESET_KEY` is missing, Connect always fails, and the old demo password does not work.

**Who gets their own key.** `API_KEYS` is a comma-separated list of issued credentials, for example `alpha,beta`. A caller who sends one of those as `X-API-Key` or `Authorization: Bearer …` is counted as that key. Any other key is ignored and the caller is counted by IP instead. Leave it empty if everyone should be counted by IP only.

**Who is allowed to tell you the client's IP.** Browsers and scripts can set `x-forwarded-for` to anything. The app only trusts it when you say how many proxy hops are real.

- `TRUSTED_PROXY_HOPS=0` (the default) ignores `x-forwarded-for` and `x-real-ip`.
- `TRUSTED_PROXY_HOPS=1` uses the rightmost address. That is the address your proxy appended, not the one the client typed on the left.
- A higher number walks further from the right. If the header is shorter than the hop count, the app refuses the request.

If the app cannot name the caller, and the caller does not have an issued key, the answer is `400` with code `CLIENT_IP_REQUIRED`. Those requests are not piled into one shared "unknown" visitor.

**For a technical reader:** Identity is `key:<issued>` or `ip:<trusted>`. Hops are `parts[parts.length - TRUSTED_PROXY_HOPS]`. `ALLOW_UNTRUSTED_FORWARDED=1` is honored only when `NODE_ENV` is not `production`. In that mode the leftmost forwarded address is used, and a request with no forwarding header is treated as `127.0.0.1` so the dashboard's live stream can connect. Production ignores the flag.

## Run it on your computer

You need Node.js 20.

1. Copy `.env.example` to `.env.local`.
2. Set `ADMIN_RESET_KEY` to something you will type into Connect.
3. Set `ALLOW_UNTRUSTED_FORWARDED=1` so the simulator's Fake IP box works. Do not set this on a public server.
4. Leave `TRUSTED_PROXY_HOPS=0` for a laptop.
5. Optionally set `API_KEYS`.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, paste the admin key, and click Connect.

**For a technical reader:** Next.js loads `.env.local` automatically. `npm test` runs Vitest. `npm run build` then `npm start` is the production process on one machine. `next` is pinned to `15.5.24`. Middleware uses the Node runtime (`experimental.nodeMiddleware`) so the in-memory counters and the dashboard share one process.

## Run it with Docker

Docker is the same app, packaged. The image always runs in production mode, so the laptop Fake IP switch is off inside the container.

From the project folder, with the admin key in your shell:

```bash
# PowerShell
$env:ADMIN_RESET_KEY="replace-with-a-long-secret"
docker compose up --build
```

```bash
# bash
export ADMIN_RESET_KEY="replace-with-a-long-secret"
docker compose up --build
```

Open `http://localhost:3000`.

What to expect:

- Connect works, because you passed `ADMIN_RESET_KEY`.
- A browser on your laptop is not behind a proxy you configured. With `TRUSTED_PROXY_HOPS` left at 0, API calls that are not using an issued key return `400`. The dashboard itself also calls the API, so give the container an issued key or put a proxy in front.
- Practical local Docker demo: set `API_KEYS` to a value you will type in the simulator's API key field, and set the same variable in the compose environment (`API_KEYS` is already wired). Then the simulator can identify itself without a fake IP.
- Do not turn on `ALLOW_UNTRUSTED_FORWARDED` for this container. Production mode ignores it.

**For a technical reader:** [Dockerfile](../Dockerfile) is a three-stage Node 20 Alpine build. The runner sets `NODE_ENV=production` and starts `npm start` on port 3000. [docker-compose.yml](../docker-compose.yml) maps that port and passes `ADMIN_RESET_KEY`, `TRUSTED_PROXY_HOPS` (default 0), and `API_KEYS`. Compose will not start usefully if `ADMIN_RESET_KEY` is unset in the environment; the variable is passed through empty and Connect fails. There is no Redis service in the compose file. Add the Upstash variables to `environment` if you want a shared store.

If a real reverse proxy is in front of the container, set `TRUSTED_PROXY_HOPS` to the number of proxies you operate. One proxy that appends the client address is `1`.

## More than one copy of the app

One process keeps its own counts in memory. Two servers, or a host that starts a fresh process per request, each have their own counts. A visitor can get a full allowance on every copy.

To share the counts, create an Upstash Redis database and set:

```
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

Then:

- The allow/deny counters are shared.
- Temporary bans are shared.
- Limit, allowlist, and blocklist edits are shared. Each process caches that snapshot for about one second.
- The dashboard numbers (the strip, the audit, the charts) stay on the process you are looking at. Opening a second copy shows a different board even when the limits are shared.

If those two variables are set and Redis cannot be reached, the app refuses the request with `503` and code `LIMITER_UNAVAILABLE`. It does not silently stop limiting. If the variables are unset, memory mode is normal, not an error.

**For a technical reader:** Fixed windows commit with `INCR` and `PEXPIRE` inside one `EVAL`. Token bucket, sliding window, and multi-window checks are the same script: a deny writes nothing. Bans are `INCR` plus `PEXPIRE` on a strike key, then `SET` with `PX` on a ban key. Live config is the JSON snapshot at `rl:config`. Vercel and other serverless hosts need these variables; in-memory state does not survive a new isolate. `experimental.nodeMiddleware` still matters so that, on one Node server, middleware and routes share memory when Redis is off.

## After it is up

1. Open `/` and Connect with the admin key. The number strip should appear, even if every figure is zero.
2. Send one request that should be allowed. On a laptop with the development flag, the simulator's Fake IP is enough. On Docker or a public host, use an issued API key or a real proxy.
3. Send more than the limit (ping defaults to 10 per minute). The next response is `429`, with `Retry-After` and a JSON body whose `error.details.retryAfter` is the wait in seconds.
4. From another terminal, request `/api/metrics` with no admin key. The status is `401`.

**For a technical reader:**

```bash
curl -i -H "x-api-key: YOUR_ISSUED_KEY" http://localhost:3000/api/ping
curl -i http://localhost:3000/api/metrics
# second command is 401

curl -i -H "x-admin-reset: YOUR_ADMIN_KEY" http://localhost:3000/api/metrics
```

On a development machine with `ALLOW_UNTRUSTED_FORWARDED=1`, you can use `-H "x-forwarded-for: 203.0.113.4"` instead of an API key.

`X-RateLimit-Reset` is a Unix timestamp in milliseconds. `Retry-After` is a number of seconds.
