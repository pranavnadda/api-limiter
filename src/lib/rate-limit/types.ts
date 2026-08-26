export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  resetTime: number;
}

export interface RateLimitConfig {
  windowMs: number;
  limit: number;
  // Algorithm: "token-bucket" or "fixed-window"
  algorithm?: "token-bucket" | "fixed-window";
  // For token bucket: refill rate per ms
  refillRate?: number;
}

export interface RateLimitOptions extends RateLimitConfig {
  keyPrefix?: string;
  // Custom key generator function
  generateKey?: (request: Request) => string;
}

export interface RateLimitStore {
  /**
   * Increment the counter for a key and return current state
   * @param key - Unique identifier for the rate limit
   * @param windowMs - Window size in milliseconds
   * @returns Promise with count and reset time
   */
  increment(key: string, windowMs: number): Promise<{ count: number; resetTime: number }>;

  /**
   * Reset the counter for a key
   * @param key - Unique identifier to reset
   */
  reset(key: string): Promise<void>;
}