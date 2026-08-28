/**
 * Ping Endpoint — Health Check
 *
 * WHY: A simple, read-only endpoint to verify the server is running.
 * Perfect for testing rate limiting because:
 * - Easy to hit with curl repeatedly
 * - Low limit (10/min) shows 429 quickly
 * - No body parsing needed
 */

import { ok, fail } from "@/lib/api-response";
import { metrics } from "@/lib/rate-limit/metrics";

export async function GET(req: Request) {
  // We don't have the IP here easily; we could extract from headers but for simplicity
  // we'll use "unknown". In a real app, you might want to pass it from middleware.
  // However, since we removed metrics from middleware, we need to record in the route.
  // For now, we'll use a placeholder IP and update the other routes similarly.
  // TODO: Extract IP from req.headers for better accuracy.
  metrics.recordRequest("ping", true, "unknown", 200, 10);
  return ok({ message: "pong", timestamp: new Date().toISOString() });
}
