import { ok, fail } from "@/lib/api-response";
import { adminSessionCookie, isAuthorizedAdmin } from "@/lib/admin-auth";

export async function POST(req: Request) {
  if (!isAuthorizedAdmin(req)) {
    return fail("UNAUTHORIZED", "Invalid or missing admin credentials", 401);
  }
  const cookie = adminSessionCookie(req);
  const res = ok({ ok: true });
  res.cookies.set(cookie.name, cookie.value, cookie.options);
  return res;
}
