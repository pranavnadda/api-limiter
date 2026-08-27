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
 * POST /api/metrics — Reset all metrics (for testing)
 *
 * WHY: Allows you to start fresh when demonstrating the dashboard.
 * In production, you'd protect this with auth or remove it.
 */
export async function POST() {
  metrics.reset();
  return ok({ message: "Metrics reset to zero" });
}

/**
 * GET /api/metrics — Aliased as GET with query params
 * GET /api/metrics?clear=true — Resets metrics (convenience)
 */
