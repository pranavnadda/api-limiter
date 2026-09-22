/**
 * Client identity — IP first, API key when present.
 *
 * WHY: Production APIs usually key on a credential, not a spoofable IP.
 * X-API-Key or Authorization: Bearer takes precedence; otherwise IP.
 */

export function extractClientIP(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  const realIp = headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }
  return "unknown";
}

export function extractApiKey(headers: Headers): string | null {
  const explicit = headers.get("x-api-key")?.trim();
  if (explicit) return explicit;
  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    return token || null;
  }
  return null;
}

/** Stable limiter key: `key:…` or `ip:…`. */
export function identityKey(headers: Headers, ip: string): string {
  const apiKey = extractApiKey(headers);
  if (apiKey) return `key:${apiKey}`;
  return `ip:${ip}`;
}

export function maskIdentity(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 12)}…`;
}
