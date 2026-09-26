/**
 * Rate Limit Public API — Module Exports
 */

export { MemoryStore } from "./memory-store";
export { RateLimiter } from "./limiter";
export { endpointConfig, defaultConfig } from "./config";
export { configStore } from "./config-store";
export { banStore } from "./ban-store";
export { MetricsCollector, metrics } from "./metrics";
export { tryCreateRedisStore } from "./redis-store";
export { compareAlgorithms } from "./compare";
export {
  extractClientIP,
  extractApiKey,
  resolveIdentity,
  maskIdentity,
} from "./identity";
export type {
  RateLimitConfig,
  RateLimitResult,
  RateLimitStore,
  RateLimitAlgorithm,
  ConsumeResult,
  LimiterDecision,
} from "./types";
export type { MetricsSnapshot, EndpointStats, AuditEntry } from "./metrics";
