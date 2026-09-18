/**
 * Ping Endpoint — Health Check
 *
 * WHY: A simple, read-only endpoint to verify the server is running.
 * Perfect for testing rate limiting because:
 * - Easy to hit with curl repeatedly
 * - Low limit (10/min) shows 429 quickly
 * - No body parsing needed
 *
 * Note: Metrics are recorded by the middleware (single source of truth),
 * not here. The route just returns a response.
 */

import { ok } from "@/lib/api-response";

export async function GET() {
  return ok({ message: "pong", timestamp: new Date().toISOString() });
}