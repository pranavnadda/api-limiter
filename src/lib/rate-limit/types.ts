export type RateLimitAlgorithm =
  | "fixed-window"
  | "token-bucket"
  | "sliding-window";

export type LimiterDecision = "allowed" | "rate_limited" | "banned" | "blocklist";

export interface WindowLimit {
  windowMs: number;
  limit: number;
}

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  resetTime: number;
}

export interface ConsumeResult {
  allowed: boolean;
  count: number;
  remaining: number;
  resetTime: number;
  limit: number;
}

export interface RateLimitConfig {
  windowMs: number;
  limit: number;
  algorithm?: RateLimitAlgorithm;
  /** Tokens added per second for token-bucket. Defaults to limit / (windowMs/1000). */
  refillRate?: number;
  /** Extra windows checked in AND with the primary windowMs/limit. */
  windows?: WindowLimit[];
}

export interface WindowCheck {
  key: string;
  config: RateLimitConfig;
}

export interface CommitResult {
  allowed: boolean;
  results: ConsumeResult[];
}

export interface RateLimitOptions extends RateLimitConfig {
  keyPrefix?: string;
  generateKey?: (request: Request) => string;
}

export interface RateLimitStore {
  increment(
    key: string,
    windowMs: number
  ): Promise<{ count: number; resetTime: number }>;
  /** Non-mutating preview of one window. */
  probe(key: string, config: RateLimitConfig): Promise<ConsumeResult>;
  consume(key: string, config: RateLimitConfig): Promise<ConsumeResult>;
  /**
   * If every window would allow, consume all of them.
   * If any would deny, consume none.
   */
  consumeAll(checks: WindowCheck[]): Promise<CommitResult>;
  reset(key: string): Promise<void>;
}
