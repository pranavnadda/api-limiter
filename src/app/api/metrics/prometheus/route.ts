import { fail } from "@/lib/api-response";
import { isAuthorizedAdmin } from "@/lib/admin-auth";
import { metrics } from "@/lib/rate-limit/metrics";

export async function GET(req: Request) {
  if (!isAuthorizedAdmin(req)) {
    return fail("UNAUTHORIZED", "Invalid or missing admin credentials", 401);
  }
  return new Response(metrics.toPrometheus(), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
