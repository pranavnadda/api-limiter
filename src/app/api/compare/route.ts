import { ok, fail } from "@/lib/api-response";
import { compareAlgorithms } from "@/lib/rate-limit/compare";

export async function POST(req: Request) {
  let body: { limit?: number; windowMs?: number; burst?: number } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  try {
    const result = await compareAlgorithms({
      limit: body.limit,
      windowMs: body.windowMs,
      burst: body.burst,
    });
    return ok(result);
  } catch (err) {
    return fail(
      "COMPARE_FAILED",
      err instanceof Error ? err.message : "Compare failed",
      500
    );
  }
}

export async function GET() {
  const result = await compareAlgorithms({});
  return ok(result);
}
