/**
 * Echo Endpoint — Request Body Reflection
 *
 * WHY: Demonstrates a POST endpoint with rate limiting.
 * Echoes back whatever JSON is sent, useful for debugging
 * client-side code and testing write operations.
 */

import { ok, fail } from "@/lib/api-response";
import { badRequest } from "@/lib/api-errors";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    return ok({ message: "echo", body });
  } catch (err) {
    return fail("PARSE_ERROR", "Invalid JSON body");
  }
}

export async function GET() {
  return fail("METHOD_NOT_ALLOWED", "Use POST instead", 405);
}
