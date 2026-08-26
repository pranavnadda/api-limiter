/**
 * Rate Limit Configuration
 *
 * WHY: Centralizing config makes it easy to adjust limits per endpoint
 * without changing middleware logic. You can change limits based on
 * environment (stricter in production, lenient in dev).
 */

import { RateLimitConfig } from "./types";

export const endpointConfig: Record<string, RateLimitConfig> = {
  ping: { windowMs: 60_000, limit: 10 },
  echo: { windowMs: 60_000, limit: 5 },
  contact: { windowMs: 600_000, limit: 3 }, // 3 per 10 minutes
};

export const defaultConfig: RateLimitConfig = {
  windowMs: 60_000,
  limit: 100,
};
