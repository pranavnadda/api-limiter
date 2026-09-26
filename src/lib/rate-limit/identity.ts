/**
 * Client identity.
 *
 * An API key counts only when it was issued (API_KEYS or the live config).
 * Any other key is ignored and the request is limited by trusted IP.
 * Missing IP does not fall back to a shared "unknown" bucket.
 */

export class ClientIpRequiredError extends Error {
  constructor() {
    super("A trusted client IP or an issued API key is required.");
    this.name = "ClientIpRequiredError";
  }
}

export function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS ?? "0";
  const hops = Number(raw);
  if (!Number.isFinite(hops) || hops < 0) return 0;
  return Math.floor(hops);
}

export function allowUntrustedForwarded(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.ALLOW_UNTRUSTED_FORWARDED === "1"
  );
}

/**
 * Trusted client IP, or null when it cannot be determined.
 * Hop count is taken from the right of x-forwarded-for.
 * Hop count 0 ignores forwarding headers.
 */
export function extractClientIP(headers: Headers): string | null {
  if (allowUntrustedForwarded()) {
    const forwarded = headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }
    const realIp = headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;
    // Browser calls such as EventSource cannot set a forwarding header.
    // Loopback is one explicit dev identity, not a shared "unknown" bucket.
    return "127.0.0.1";
  }

  const hops = trustedProxyHops();
  if (hops <= 0) return null;

  const forwarded = headers.get("x-forwarded-for");
  if (!forwarded) return null;
  const parts = forwarded
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < hops) return null;
  return parts[parts.length - hops] || null;
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

export function parseIssuedKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** `key:…` for an issued credential, otherwise `ip:…`. Null when neither exists. */
export function resolveIdentity(
  headers: Headers,
  trustedIp: string | null,
  issuedKeys: readonly string[]
): string | null {
  const apiKey = extractApiKey(headers);
  if (apiKey && issuedKeys.includes(apiKey)) return `key:${apiKey}`;
  if (trustedIp) return `ip:${trustedIp}`;
  return null;
}

/** Same prefix mask for every identity, including short IPv4 keys. */
export function maskIdentity(id: string): string {
  if (id.length <= 4) return "…";
  return `${id.slice(0, 4)}…`;
}
