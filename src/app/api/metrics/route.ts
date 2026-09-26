import { ok, fail } from "@/lib/api-response";
import { isAuthorizedAdmin } from "@/lib/admin-auth";
import { metrics } from "@/lib/rate-limit/metrics";

export async function GET(req: Request) {
  if (!isAuthorizedAdmin(req)) {
    return fail("UNAUTHORIZED", "Invalid or missing admin credentials", 401);
  }
  return ok(metrics.getSnapshot());
}

export async function POST(req: Request) {
  if (!isAuthorizedAdmin(req)) {
    return fail("UNAUTHORIZED", "Invalid or missing admin credentials", 401);
  }
  metrics.reset();
  return ok({ message: "Metrics reset to zero" });
}
