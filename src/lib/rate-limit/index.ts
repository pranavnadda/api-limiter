/**
 * Rate Limit Public API — Module Exports
 *
 * WHY: A single entry point makes it easy for consumers to import
 * everything they need without deep file knowledge.
 */

export { MemoryStore } from "./memory-store";
export { RateLimiter } from "./limiter";
export { endpointConfig, defaultConfig } from "./config";
export type { RateLimitConfig, RateLimitResult, RateLimitStore } from "./types";