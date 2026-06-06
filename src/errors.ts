/**
 * Exception hierarchy for the WellMarked SDK.
 *
 * Every HTTP error returned by the API is translated into a typed error
 * whose class corresponds to the HTTP status and whose `code` matches the
 * `error.code` field in the response body. Catch `WellMarkedError` for
 * anything raised by the SDK; catch a more specific subclass when you want
 * to handle one failure mode.
 */

export interface WellMarkedErrorOptions {
  code?: string | undefined;
  statusCode?: number | undefined;
  retryAfter?: number | undefined;
  retryAfterMs?: number | undefined;
  requestId?: string | undefined;
  cause?: unknown;
}

export class WellMarkedError extends Error {
  readonly code: string | undefined;
  readonly statusCode: number | undefined;
  /**
   * Whole-second back-off (HTTP-standard Retry-After). Set on every
   * 429: monthly quota (seconds until period reset) and per-second cap
   * (rounded up from the millisecond hint).
   */
  readonly retryAfter: number | undefined;
  /**
   * Sub-second back-off, only populated for `rate_limit_too_fast`
   * 429s. Lets callers retry as soon as the per-tier slot frees
   * without sleeping a full second. `undefined` when the server
   * didn't send a Retry-After-Ms header.
   */
  readonly retryAfterMs: number | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, options: WellMarkedErrorOptions = {}) {
    super(message);
    this.name = "WellMarkedError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.retryAfter = options.retryAfter;
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    // Maintain proper prototype chain when transpiled to ES5.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when the SDK couldn't reach the API (DNS, TCP, TLS, timeout). */
export class APIConnectionError extends WellMarkedError {
  constructor(message: string, options: WellMarkedErrorOptions = {}) {
    super(message, options);
    this.name = "APIConnectionError";
    Object.setPrototypeOf(this, APIConnectionError.prototype);
  }
}

/** Raised for any non-2xx response from the API. */
export class APIStatusError extends WellMarkedError {
  constructor(message: string, options: WellMarkedErrorOptions = {}) {
    super(message, options);
    this.name = "APIStatusError";
    Object.setPrototypeOf(this, APIStatusError.prototype);
  }
}

/** 401 — missing or invalid API key. */
export class AuthenticationError extends APIStatusError {
  constructor(message: string, options: WellMarkedErrorOptions = {}) {
    super(message, options);
    this.name = "AuthenticationError";
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

/** 403 — account inactive, plan does not allow this operation, or job belongs to another user. */
export class PermissionDeniedError extends APIStatusError {
  constructor(message: string, options: WellMarkedErrorOptions = {}) {
    super(message, options);
    this.name = "PermissionDeniedError";
    Object.setPrototypeOf(this, PermissionDeniedError.prototype);
  }
}

/** 404 — job not found or expired past the 6-hour retention window. */
export class NotFoundError extends APIStatusError {
  constructor(message: string, options: WellMarkedErrorOptions = {}) {
    super(message, options);
    this.name = "NotFoundError";
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

/**
 * 422 — request was syntactically valid but couldn't be fulfilled.
 *
 * Common `code` values:
 *   - `no_content`            — could not identify main content on the page
 *   - `target_timeout`        — the target URL timed out
 *   - `js_rendering_disabled` — `renderJs=true` but the server has it off
 *   - `bulk_cap_exceeded`     — more URLs than the plan allows per request
 *   - `crawl_depth_exceeded`  — requested depth above the plan cap
 */
export class UnprocessableEntityError extends APIStatusError {
  constructor(message: string, options: WellMarkedErrorOptions = {}) {
    super(message, options);
    this.name = "UnprocessableEntityError";
    Object.setPrototypeOf(this, UnprocessableEntityError.prototype);
  }
}

/**
 * 429 — a request was rejected for exceeding a rate limit.
 *
 * The `code` attribute discriminates which limit was hit:
 *   - `rate_limit_exceeded` — the monthly plan quota is exhausted.
 *     `retryAfter` is the number of **seconds** until the period
 *     resets (often hours or days). `retryAfterMs` is `undefined`.
 *   - `rate_limit_too_fast` — the per-second cap was hit (Free 5/s,
 *     Pro 20/s, Growth 100/s, Enterprise unlimited). `retryAfterMs`
 *     is the precise millisecond back-off; `retryAfter` is the same
 *     value rounded up to a whole second for clients that only
 *     respect the HTTP-standard header.
 *
 * Branch on `code` to choose between sleeping milliseconds and
 * waiting for the next billing period.
 */
export class RateLimitError extends APIStatusError {
  constructor(message: string, options: WellMarkedErrorOptions = {}) {
    super(message, options);
    this.name = "RateLimitError";
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

/** 5xx — something went wrong on the API side. */
export class InternalServerError extends APIStatusError {
  constructor(message: string, options: WellMarkedErrorOptions = {}) {
    super(message, options);
    this.name = "InternalServerError";
    Object.setPrototypeOf(this, InternalServerError.prototype);
  }
}

type APIStatusErrorCtor = new (
  message: string,
  options?: WellMarkedErrorOptions,
) => APIStatusError;

const STATUS_TO_EXC: Record<number, APIStatusErrorCtor> = {
  401: AuthenticationError,
  403: PermissionDeniedError,
  404: NotFoundError,
  422: UnprocessableEntityError,
  429: RateLimitError,
};

/**
 * Build the right error subclass for a given HTTP status + JSON body.
 *
 * `headers` is optional — when supplied, the function reads
 * `Retry-After-Ms` from it so the resulting `RateLimitError` can
 * expose millisecond-precise back-off on the per-second
 * (`rate_limit_too_fast`) variant.
 */
export function fromResponse(
  statusCode: number,
  body: unknown,
  requestId?: string,
  headers?: Headers | Record<string, string>,
): APIStatusError {
  let code: string | undefined;
  let message = `HTTP ${statusCode}`;
  let retryAfter: number | undefined;
  let retryAfterMs: number | undefined;

  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: unknown }).error;
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      if (typeof e.code === "string") code = e.code;
      if (typeof e.message === "string") message = e.message;
      if (typeof e.retry_after === "number") retryAfter = e.retry_after;
    }
  }

  if (headers) {
    // Headers API (case-insensitive .get) and plain Record (case
    // matters); try the Headers method first, fall back to direct
    // lookup with both casings.
    const raw =
      typeof (headers as Headers).get === "function"
        ? (headers as Headers).get("Retry-After-Ms")
        : ((headers as Record<string, string>)["Retry-After-Ms"]
            ?? (headers as Record<string, string>)["retry-after-ms"]);
    if (raw != null) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 0) retryAfterMs = parsed;
    }
  }

  let Ctor: APIStatusErrorCtor;
  if (statusCode >= 500) {
    Ctor = InternalServerError;
  } else {
    Ctor = STATUS_TO_EXC[statusCode] ?? APIStatusError;
  }

  return new Ctor(message, { code, statusCode, retryAfter, retryAfterMs, requestId });
}
