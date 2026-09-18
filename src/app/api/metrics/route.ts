/**
 * Metrics Endpoint — Real-time Rate Limiting Stats
 *
 * WHY: This endpoint exposes the metrics collector's data as JSON.
 * The dashboard will poll this endpoint every few seconds to show
 * live updates of requests, blocks, and active users.
 *
 * Also includes a reset endpoint for testing (POST /api/metrics).
 */

import { ok, fail } from "@/lib/api-response";
import { metrics } from "@/lib/rate-limit/metrics";

/**
 * GET /api/metrics — Return current metrics snapshot
 */
export async function GET() {
  const snapshot = metrics.getSnapshot();
  return ok(snapshot);
}

/**
 * POST /api/metrics — Reset all metrics (for testing only)
 *
 * WHY: Allows starting fresh for demos. PROTECTED: requires
 * X-Admin-Reset secret so it cannot be wiped by random clients.
 */
export async function POST(req: Request) {
  const adminKey = req.headers.get("x-admin-reset");
  // Use a simple env-backed secret; falls back to a demo value for portfolio.
  // WHY warn: makes it obvious in real deploys that the insecure demo default
  // is in effect and ADMIN_RESET_KEY should be set.
  if (!process.env.ADMIN_RESET_KEY) {
    console.warn(
      "[metrics] ADMIN_RESET_KEY is not set; using insecure demo default 'demo-reset-key'."
    );
  }
  const expected = process.env.ADMIN_RESET_KEY || "demo-reset-key";
  if (adminKey !== expected) {
    return fail("UNAUTHORIZED", "Invalid or missing X-Admin-Reset header", 401);
  }
  metrics.reset();
  return ok({ message: "Metrics reset to zero" });
}
