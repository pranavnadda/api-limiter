import { fail, ok } from "@/lib/api-response";
import { isAuthorizedAdmin } from "@/lib/admin-auth";
import { configStore } from "@/lib/rate-limit/config-store";
import type { RateLimitAlgorithm, WindowLimit } from "@/lib/rate-limit/types";

export async function GET() {
  return ok(configStore.list());
}

interface ConfigBody {
  endpoint?: string;
  limit?: number;
  windowMs?: number;
  algorithm?: RateLimitAlgorithm;
  refillRate?: number;
  windows?: WindowLimit[] | null;
  allowlist?: string[];
  blocklist?: string[];
  ban?: {
    threshold?: number;
    strikeWindowMs?: number;
    banMs?: number;
  };
}

export async function POST(req: Request) {
  if (!isAuthorizedAdmin(req)) {
    return fail("UNAUTHORIZED", "Invalid or missing X-Admin-Reset header", 401);
  }

  let body: ConfigBody;
  try {
    body = await req.json();
  } catch {
    return fail("PARSE_ERROR", "Invalid JSON body");
  }

  try {
    if (body.allowlist || body.blocklist) {
      configStore.setLists(body.allowlist, body.blocklist);
    }
    if (body.ban) {
      configStore.setBan(body.ban);
    }
    if (body.endpoint) {
      configStore.setEndpoint(body.endpoint, {
        limit: body.limit,
        windowMs: body.windowMs,
        algorithm: body.algorithm,
        refillRate: body.refillRate,
        windows: body.windows,
      });
    }
    return ok(configStore.list());
  } catch (err) {
    return fail(
      "VALIDATION_ERROR",
      err instanceof Error ? err.message : "Invalid config"
    );
  }
}
