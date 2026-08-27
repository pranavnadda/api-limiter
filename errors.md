# Errors & Fixes — API Rate Limiter Project

Every error we hit, from start to finish, with the root cause, fix, and design rationale.

---

## 1. Middleware at wrong location (Phase 0/1 critical)

**Symptoms:** Only 200 OK responses, never 429; metrics always 0; middleware manifest empty.

**Root Cause:** `middleware.ts` was moved from `src/middleware.ts` to project root (`middleware.ts`). Next.js 15 with `src/` directory structure requires middleware inside `src/`.

**Fix:** `mv middleware.ts src/middleware.ts`

**Approach / WHY:** Next.js docs specify middleware must live at `src/middleware.ts` when using `src/`. We followed the spec rather than inventing a workaround.

---

## 2. Port 3000 already in use / server on wrong port (Phase 1/2)

**Symptoms:** Requests to `localhost:3005` return 429 correctly, but metrics show 0; UI shows no updates.

**Root Cause:** Old Next.js dev server still running on port 3005 (PID 6424) from earlier session. It uses its own `MemoryStore` / `metrics` singleton instance (separate from the current code). New `src/middleware.ts` isn't loaded by that process.

**Fix:** Kill old server process (`taskkill /F /PID 6424` or `lsof -ti:3005 | xargs kill -9`) and restart `npm run dev` on fresh port.

**Approach / WHY:** In-memory singletons live in process memory. Two server processes = two isolated stores. This is expected behavior, not a code bug.

---

## 3. `grep` dependency added accidentally (setup)

**Symptoms:** `package.json` has `"grep": "^0.1.0"` that wasn't requested.

**Root Cause:** Unknown (possibly user edit or dependency resolution artifact).

**Fix:** `npm uninstall grep`

**Approach / WHY:** Clean dependency tree = predictable builds. Unused packages can cause audit warnings and bloat.

---

## 4. Metrics collector always zero (Phase 1, after middleware fix)

**Symptoms:** `/api/metrics` returns all zeros even after requests.

**Root Cause:** If middleware isn't running (see #1), `metrics.recordRequest()` never gets called.

**Fix:** Fix middleware location (#1) and restart server fresh (#2).

**Approach / WHY:** Metrics are a side effect of middleware, not a standalone service. Without middleware, no records are created.

---

## 5. Middleware compilation failure / 500 error (Phase 0)

**Symptoms:** Browser shows HTML error page instead of JSON; server logs compilation errors.

**Root Cause:** Old middleware at wrong path or import errors (`@/lib` aliases not resolving correctly with wrong file location).

**Fix:** Move middleware to `src/middleware.ts`; ensure `tsconfig.json` path aliases are correct.

**Approach / WHY:** Path aliases (`@/*` -> `./src/*`) only work when files are within the `src/` tree.

---

## 6. Rate limit headers missing on responses (Phase 0/1)

**Symptoms:** `curl -i` shows no `X-RateLimit-*` headers.

**Root Cause:** Middleware not running = headers never set.

**Fix:** Same as #1.

---

## 7. Page not reflecting dashboard updates (Phase 2)

**Symptoms:** `/api/ping` works, `/api/metrics` works, but `http://localhost:3005/` (dashboard) stays blank.

**Root Cause:** Old server process serving the page (same as #2). New `src/app/page.tsx` isn't loaded by old process.

**Fix:** Kill old server, restart.

---

## Design Principles Behind All Fixes

- **Fail-open, not fail-closed:** If middleware crashes, requests pass through (better UX than broken site).
- **Singleton pattern for in-memory:** One `MemoryStore`, one `metrics` instance per process. Multiple processes = isolation (requires Redis for multi-server).
- **Document-first:** Every fix documented in docs and code (WHY comments).
- **Step-by-step verification:** Each fix verified with `curl -i` to confirm headers + 429 + metrics update.

---

*Created: 2026-08-27 — as part of Phase 2 dashboard build and error logging.*
