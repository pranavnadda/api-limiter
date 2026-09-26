/**
 * Shared admin secret for dashboard reads and mutations.
 * Missing ADMIN_RESET_KEY rejects every admin call. There is no demo fallback.
 */

import { createHash, timingSafeEqual } from "crypto";

const COOKIE = "admin_session";

export function adminKeyConfigured(): boolean {
  return Boolean(process.env.ADMIN_RESET_KEY);
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function presentedAdminSecret(req: Request): string | null {
  return req.headers.get("x-admin-reset") ?? readCookie(req, COOKIE);
}

/** SHA-256 both sides so timingSafeEqual always compares equal-length digests. */
export function secretsMatch(presented: string | null, expected: string): boolean {
  const presentedHash = createHash("sha256")
    .update(presented ?? "")
    .digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  const equal = timingSafeEqual(presentedHash, expectedHash);
  return equal && presented !== null && presented.length > 0;
}

export function isAuthorizedAdmin(req: Request): boolean {
  const expected = process.env.ADMIN_RESET_KEY;
  if (!expected) return false;
  return secretsMatch(presentedAdminSecret(req), expected);
}

export function adminSessionCookie(req: Request): {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    sameSite: "lax";
    secure: boolean;
    path: string;
    maxAge: number;
  };
} {
  const key = process.env.ADMIN_RESET_KEY ?? "";
  const secure = new URL(req.url).protocol === "https:";
  return {
    name: COOKIE,
    value: key,
    options: {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: 60 * 60 * 12,
    },
  };
}
