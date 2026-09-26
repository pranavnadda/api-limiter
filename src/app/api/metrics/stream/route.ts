import { fail } from "@/lib/api-response";
import { isAuthorizedAdmin } from "@/lib/admin-auth";
import { metrics } from "@/lib/rate-limit/metrics";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!isAuthorizedAdmin(req)) {
    return fail("UNAUTHORIZED", "Invalid or missing admin credentials", 401);
  }
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
        );
      };
      unsubscribe = metrics.subscribe((snapshot) => send(snapshot));
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
