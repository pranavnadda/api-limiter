import { fail } from "./api-response";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400,
    public details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function badRequest(message = "Bad request", details?: unknown) {
  return new ApiError("BAD_REQUEST", message, 400, details);
}

export function unauthorized(message = "Unauthorized", details?: unknown) {
  return new ApiError("UNAUTHORIZED", message, 401, details);
}

export function notFound(message = "Not found", details?: unknown) {
  return new ApiError("NOT_FOUND", message, 404, details);
}

export function conflict(message = "Conflict", details?: unknown) {
  return new ApiError("CONFLICT", message, 409, details);
}

export function tooManyRequests(
  message = "Too many requests",
  retryAfter?: number
) {
  return new ApiError("RATE_LIMITED", message, 429, { retryAfter });
}

export function handleError(err: unknown) {
  if (err instanceof ApiError) {
    const init: ResponseInit = {};
    if (err.status === 429 && err.details) {
      const retryAfter = (err.details as { retryAfter?: number }).retryAfter;
      if (retryAfter) {
        (init as { headers?: Record<string, string> }).headers = {
          "Retry-After": String(retryAfter),
        };
      }
    }
    return fail(err.code, err.message, err.status, err.details, init);
  }

  console.error("[API Error]", err);
  return fail("INTERNAL_ERROR", "Internal server error", 500);
}
