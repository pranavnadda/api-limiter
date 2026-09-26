# Use guide

Last updated: 2026-09-26

This is the end-to-end guide for the rate limiter dashboard. Read the plain paragraphs if you want to know what to click. The notes marked **For a technical reader** name the headers, status codes, and settings behind each control.

How to get the app running is in [deployment-guide.md](deployment-guide.md).

## What this app is

The homepage is a control panel. It is not the API.

The API is the set of doors behind that panel: ping, echo, and contact. Each door allows only so many knocks in a stretch of time. After that, the app says "slow down" instead of doing the work. That answer is HTTP status `429`.

The panel shows those knocks as they happen, lets you fire a practice burst, and lets you change the rules if you have the admin key.

**For a technical reader:** Enforcement is Next.js middleware on `/api/*`. The page at `/` only talks to admin routes (`/api/config`, `/api/metrics`, `/api/metrics/stream`, `/api/compare`, `/api/admin/session`). A request the limiter allows continues to the route. A request it rejects never reaches the route.

## First time you open it

1. Open the site (locally that is `http://localhost:3000`).
2. You see a short page titled **Rate limiter**, a password field labeled **Admin key**, and a **Connect** button.
3. Type the admin key that was chosen when the app was started. That value is the environment variable `ADMIN_RESET_KEY`. There is no built-in password.
4. Click **Connect**.

If the key is wrong, you stay on this screen and see **Admin key rejected**. If the key is right, the full board appears.

The browser remembers the key for this site. The next visit reconnects on its own. The key is also stored as an httpOnly cookie so the live updates can keep coming. You cannot read that cookie from the page.

**For a technical reader:** Connect sends `POST /api/admin/session` with header `X-Admin-Reset`. A match sets cookie `admin_session` (`HttpOnly`, `SameSite=Lax`, 12 hours). Later reads send that cookie. The key is also kept in `localStorage` under `api-limiter-admin-key` so the page can reconnect. Comparison is a SHA-256 digest plus `timingSafeEqual`. An empty `ADMIN_RESET_KEY` rejects every admin call, including the old demo string `demo-reset-key`.

## The top of the board

### Live stream / Polling

A dot next to the title.

- **Live stream** means the board is receiving updates as requests happen.
- **Polling** means the live connection dropped. The board then checks for new numbers every 2 seconds. The numbers are still real. They are just a little later.

**For a technical reader:** Live stream is `EventSource` on `GET /api/metrics/stream` (server-sent events). The cookie from Connect is sent automatically. On error, the page closes the stream and polls `GET /api/metrics` every 2 seconds.

### Admin key

The same password field, now in the toolbar. Change it here before **Reset metrics**, **Save**, or **Save lists** if you rotated the key. Those buttons send whatever is currently in the field.

### Reset metrics

Clears the numbers, the charts' source data, the recent-request list, and the audit list. It does **not** forgive anyone who is already over their limit. The counters that decide allow or deny stay where they are. After a reset, the board looks empty until new requests arrive. People who were rate limited are still rate limited.

**For a technical reader:** `POST /api/metrics` with `X-Admin-Reset`. That calls `metrics.reset()` only. `MemoryStore`, Redis counters, and the ban map are untouched.

## The number strip

Six figures across the top.

| Label | What it means |
|---|---|
| **Total** | Every request the limiter has seen since the last reset. |
| **Allowed** | Requests that were let through. |
| **Blocked** | Requests refused for a limit or because the caller is on the blocklist. |
| **Banned** | Requests refused because the caller is in a temporary ban. These are not also counted in Blocked. |
| **Active identities** | How many distinct callers were seen in the last 5 minutes. The names are shortened. |
| **Req/s** | Rough requests per second over the last minute. |

Allowed + Blocked + Banned equals Total.

A red banner appears when Total is at least 8 and 30% or more of those requests were blocked. It is a warning, not a new limit.

**For a technical reader:** Decisions are `allowed`, `rate_limited`, `banned`, and `blocklist`. `rate_limited` and `blocklist` increment Blocked. `banned` increments Banned only. Prometheus uses one `result` label per request, so summing the three series does not double-count bans. The scrape URL is `/api/metrics/prometheus` and it requires the same admin cookie or `X-Admin-Reset` header. Active identities use a 5-minute last-seen window. Req/s uses up to 60 seconds of history, capped at 5,000 events.

## Simulator

This is how you try the limiter without a terminal.

| Control | What it means |
|---|---|
| **Endpoint** | Which door to knock on. **GET /api/ping** is a health check (10 per minute). **POST /api/echo** repeats the JSON you would send (5 per minute). **POST /api/contact** is a fake contact form (3 per 10 minutes). |
| **Count** | How many knocks to send in this burst. The box allows 1 to 100. |
| **Delay (ms)** | Pause between knocks, in milliseconds. 80 means a little under a tenth of a second. 0 sends them as fast as the browser can. |
| **Fake IP** | Pretend to be a different visitor. Leave it blank to be "this computer." Two different fake IPs each get their own allowance. |
| **API key** | Optional. Only a key that was issued when the app started gets its own allowance. Any other text is ignored, and the request is still counted against the IP. |
| **Send N requests** | Starts the burst. The button shows the count you chose. |

The log under the button is one line per knock:

- `#1 200 remaining 9` — allowed. `200` is success. `remaining 9` means 9 knocks left in this window.
- `#11 429 remaining 0` — refused. Wait, then try again.
- `#3 403` — this caller is on the blocklist.
- `#4 400` — the app could not tell who you are (common when Fake IP is used on a production deploy).

A green line was allowed. A red line was `429` or `403`.

**For a technical reader:** The simulator calls `/api/<endpoint>` from the browser. Fake IP sets `x-forwarded-for`. API key sets `X-API-Key`. Those headers matter only when the server is allowed to trust them. In development, set `ALLOW_UNTRUSTED_FORWARDED=1` or every fake IP is ignored and you share `127.0.0.1`. In production that flag is ignored. Issued keys come from `API_KEYS` (comma-separated). An unknown key does not create a new bucket and does not return `401`. Contact simulator bodies are valid on purpose, so you are testing the limit rather than form errors. Echo sends `{ n: i }`.

Default limits, until someone clicks Save:

- ping: 10 requests / 60,000 ms
- echo: 5 / 60,000 ms
- contact: 3 / 600,000 ms
- any other `/api/...` name: 100 / 60,000 ms

## Live limits

One card per endpoint (ping, echo, contact). Changes apply to the next request after **Save**. They do not rewrite the past.

| Control | What it means |
|---|---|
| **limit** | How many requests are allowed in the window. |
| **Window ms** | How long that allowance lasts, in milliseconds. 60000 is one minute. 600000 is ten minutes. The smallest accepted value is 100. |
| **Algorithm** | The style of counting. See below. |
| **2nd window limit** and **2nd window ms** | An extra rule that must also pass. Leave limit or window at 0 to use only the first rule. Example: 10 per minute and also 2 per 10 seconds. |
| **Save** | Writes that card. You need the admin key. A green notice says **Updated ping limits.** A failure says to check the admin key. |

Algorithms, in plain words:

- **Fixed window** — a bucket that fills until the clock hits the next boundary, then empties. Traffic can bunch up at the boundary: the end of one minute and the start of the next can both be full.
- **Token bucket** — a cup of tokens that refills steadily. You can spend a burst, then you wait for tokens to come back. You do not get a second full burst just because the clock rolled over.
- **Sliding window** — looks at the last stretch of time, not the current calendar bucket. A request ages out exactly one window after it happened.

**For a technical reader:** Save sends `POST /api/config` with `limit`, `windowMs`, `algorithm`, and either `windows: [{ limit, windowMs }]` or `windows: null`. Both windows must allow the request or the request is denied, and a deny does not consume either window. `windowMs` must be at least 100 and `limit` at least 1. The primary window is calendar-aligned (`floor(now / windowMs) * windowMs`). Token refill defaults to `limit / (windowMs / 1000)` tokens per second.

## Charts

### Requests per second

A line of the Req/s number over time. The board keeps about the last 30 samples. One sample is not enough to draw a line; you will see **Waiting for a second sample** until the next update.

### Allowed vs blocked

One bar per endpoint. Green is allowed, red is blocked, gold is banned. Empty until the simulator or a real client has hit something.

## Recent requests

The latest calls, newest first, up to 50.

| Column | What it means |
|---|---|
| **Time** | When the limiter saw it, in your local clock. |
| **Identity** | Who it was counted as, shortened. You will see the start of `ip:` or `key:` and then an ellipsis. Full addresses are not shown. |
| **Endpoint** | `ping`, `echo`, `contact`, or the first segment under `/api/`. |
| **Status** | `—` means the limiter let it through. The panel does not know if the route later returned an error. `429` means limited or banned. `403` means blocklist. |
| **Left** | How many requests that caller still had in the tightest window after this call. |

**For a technical reader:** Middleware cannot see the route's final status after `NextResponse.next()`, so allowed rows store `status: null`, rendered as `—`. `X-RateLimit-Remaining` is the smallest remaining value across the windows that were checked. Identities go through `maskIdentity`: the first four characters, then `…`.

## Blocked audit

Only the refusals. Use **Reason** to filter.

| Reason | What happened |
|---|---|
| **All** | Every refusal. |
| **Rate limit** | Over the allowance. Status was `429`. |
| **Ban** | Too many refusals in a short time, so the caller is sitting out. Status was `429`. |
| **Blocklist** | The name or IP was on the block list. Status was `403`. |

**Retry** is how many seconds the response told the caller to wait.

A ban is automatic. After 5 rate-limit refusals inside 60 seconds, that caller is banned for 15 minutes. The board has no separate "ban settings" form. The audit is how you see it.

**For a technical reader:** Defaults live on the config store: `threshold` 5, `strikeWindowMs` 60000, `banMs` 900000. Change them with `POST /api/config` and a `ban` object. Values must be finite: threshold at least 1, strike window at least 100 ms, ban at least 1000 ms. The audit keeps the latest 100 refusals.

## Allowlist and blocklist

Two text boxes. Put one name per line. Click **Save lists**.

- **Allowlist** — these callers skip the limit. They are still recorded as allowed.
- **Blocklist** — these callers get `403` and the message that they are blocked. They never reach the route.

If a name is on both lists, the block wins.

What to type: the raw IP you see in Fake IP (`203.0.113.4`), or the full identity the limiter uses (`ip:203.0.113.4` or `key:your-issued-key`). The board shows a shortened identity in the tables. The list needs the real value, not the shortened one.

**For a technical reader:** `POST /api/config` with `allowlist` and `blocklist` arrays. `isBlocked` runs before `isAllowed`. A match is against the identity string (`ip:…` or `key:…`) or the raw trusted IP.

## Algorithm comparison

**Run comparison** draws three lines for the same pretend burst. It does not change live counters, bans, or the number strip.

The chart's horizontal axis is the knock number. The vertical axis is how many requests were left after that knock. The lines are **fixed**, **token**, and **sliding**. This is the picture of the three styles described under Live limits, including the fixed-window pile-up at a boundary.

**For a technical reader:** `POST /api/compare` with limit 10, window 60,000 ms, and burst 16. The handler uses a private `MemoryStore` and a fake clock. Burst, limit, and window are capped (burst 1–100, limit 1–10,000, window 100–86,400,000). A larger burst returns `400`, so one click cannot stall the process.

## Try this

1. Connect with the admin key.
2. In the simulator, leave the endpoint on **GET /api/ping**.
3. Set Count to 12. That is more than the default of 10 per minute.
4. If you are on a laptop in development, type a Fake IP such as `203.0.113.4`.
5. Click **Send 12 requests**.
6. The log counts down remaining, then shows `429`. The strip's Blocked number goes up. A row appears under Blocked audit with reason Rate limit.
7. Click **Reset metrics**. The strip goes back to zeros. Send one more ping with the same fake IP. If you are still inside the minute, it can still be `429`, because reset did not clear the counter.
8. Change the fake IP and send again. That visitor still has a full allowance.

## If something looks wrong

**Connect says the admin key was rejected.** The field does not match `ADMIN_RESET_KEY` on the server. There is no default key.

**Every simulator line is 400.** The server could not name the caller. On your laptop, set `ALLOW_UNTRUSTED_FORWARDED=1` and restart. On a production deploy, that flag does nothing; you need a trusted proxy or an issued API key. See the deployment guide.

**Fake IP does nothing.** Two different strings still share one counter. You are in production, or the development flag is off, so the header is ignored.

**Reset failed — check the admin key.** The toolbar key does not match the server. Connect again with the current key.

**The board stays on Polling.** The live stream could not stay open. Numbers still update every 2 seconds. A proxy that buffers server-sent events causes this.

**Allowed requests show a dash, not 200, in Recent requests.** That is intentional. The dash means the limiter allowed the call. It is not the route's own status code.
