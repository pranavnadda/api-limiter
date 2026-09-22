import { metrics } from "@/lib/rate-limit/metrics";

export async function GET() {
  return new Response(metrics.toPrometheus(), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
