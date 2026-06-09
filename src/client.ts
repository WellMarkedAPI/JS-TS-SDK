/**
 * WellMarked client.
 *
 * The client is a thin, typed wrapper around the HTTP API. All endpoint
 * methods are async — there is no separate sync/async split as in the
 * Python SDK because JavaScript I/O is async by default.
 *
 *     import { WellMarked } from "wellmarked";
 *
 *     const wm = new WellMarked({ apiKey: "wm_..." });
 *     const result = await wm.extract("https://example.com/article");
 *     console.log(result.markdown);
 *
 * The API key can also be passed via the `WELLMARKED_API_KEY` environment
 * variable (Node.js), in which case `new WellMarked()` is enough.
 */
import {
  APIConnectionError,
  APIStatusError,
  WellMarkedError,
  fromResponse,
} from "./errors.js";
import {
  type BulkJob,
  type CrawlJob,
  type ExtractResult,
  type RotatedKey,
  type RotatedWebhookSecret,
  type Usage,
  bulkJobFromResponse,
  crawlJobFromResponse,
  extractResultFromResponse,
  rotatedKeyFromResponse,
  rotatedWebhookSecretFromResponse,
  usageFromResponse,
} from "./models.js";
import { VERSION } from "./version.js";

const DEFAULT_BASE_URL = "https://api.wellmarked.io";
const DEFAULT_TIMEOUT_MS = 30_000;

const RESERVED_HEADERS = new Set([
  "authorization",
  "content-type",
  "accept",
]);

export interface WellMarkedOptions {
  /**
   * Your WellMarked API key (`wm_...`). Falls back to the
   * `WELLMARKED_API_KEY` environment variable (Node.js only).
   */
  apiKey?: string;
  /** API base URL. Override for testing. */
  baseUrl?: string;
  /** Per-request timeout, milliseconds. Defaults to 30000 (30s). */
  timeoutMs?: number;
  /**
   * Bring your own `fetch`. Defaults to the global `fetch`. Useful for
   * polyfills, custom agents/proxies, or test mocking.
   */
  fetch?: typeof fetch;
  /**
   * Extra headers sent on every request — useful for adding an internal
   * correlation id, a custom user agent suffix, etc.
   *
   * Authorization / Content-Type / Accept are reserved and silently
   * ignored if passed (the SDK manages those itself).
   */
  headers?: Record<string, string>;
}

export interface ExtractOptions {
  /**
   * Use Playwright to render JS-heavy pages. Requires a Pro/Enterprise
   * plan AND `ENABLE_JS_RENDERING=true` on the API instance.
   */
  renderJs?: boolean;
}

/**
 * Options shared by `bulk` and `crawl` for opting in to a job.completed
 * webhook delivery in lieu of polling.
 */
export interface JobWebhookOptions {
  /**
   * HTTPS URL to receive a signed POST when the job finishes. Use
   * `verifyWebhook` to verify deliveries on the receiving side.
   *
   * Throws `UnprocessableEntityError` with code `webhook_url_invalid`
   * if the URL is non-https or resolves to a private/loopback host.
   */
  webhookUrl?: string;
  /**
   * When `true`, the webhook payload includes the full `results` array
   * inline (capped at ~5 MB; over the cap the payload falls back to
   * the thin shape with `results_truncated_for_size: true`).
   *
   * When `false` (default), the payload carries only metadata and a
   * `results_url` pointing back at `getJob`.
   */
  webhookIncludeResults?: boolean;
}

export interface BulkOptions extends JobWebhookOptions {
  renderJs?: boolean;
}

export interface CrawlOptions extends JobWebhookOptions {
  /** Max BFS depth from the root. Defaults to 1. Must be >= 0. */
  depth?: number;
  renderJs?: boolean;
}

export interface WaitForJobOptions {
  /** Milliseconds to sleep between polls. Defaults to 2000. */
  pollIntervalMs?: number;
  /** Total ms to wait before timing out. `null` waits forever. Defaults to 300000 (5 min). */
  timeoutMs?: number | null;
}

function resolveApiKey(apiKey: string | undefined): string {
  if (apiKey) return apiKey;
  const env =
    typeof process !== "undefined" && process.env
      ? process.env.WELLMARKED_API_KEY
      : undefined;
  if (env) return env;
  throw new Error(
    "No API key provided. Pass apiKey: ... to the client or set the " +
      "WELLMARKED_API_KEY environment variable. Generate a key at " +
      "https://wellmarked.io.",
  );
}

function defaultHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `wellmarked-js/${VERSION}`,
  };
}

function mergeHeaders(
  apiKey: string,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const out = defaultHeaders(apiKey);
  if (!extra) return out;
  for (const [k, v] of Object.entries(extra)) {
    if (RESERVED_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RequestInitWithSignal {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export class WellMarked {
  private apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: WellMarkedOptions = {}) {
    this.apiKey = resolveApiKey(options.apiKey);
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const f = options.fetch ?? (typeof fetch !== "undefined" ? fetch : undefined);
    if (!f) {
      throw new Error(
        "No fetch implementation available. Pass `fetch:` to the client " +
          "(undici, node-fetch, etc.) or upgrade to Node 18+.",
      );
    }
    // Bind so `this` isn't lost when calling globalThis.fetch.
    this.fetchImpl = f.bind(globalThis) as typeof fetch;
    this.extraHeaders = {};
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        if (RESERVED_HEADERS.has(k.toLowerCase())) continue;
        this.extraHeaders[k] = v;
      }
    }
  }

  // ── Endpoints ──────────────────────────────────────────────────────────────

  /**
   * Extract clean Markdown from a single URL.
   *
   * Throws:
   *   - `RateLimitError`            — monthly plan limit reached.
   *   - `UnprocessableEntityError`  — `no_content`, `target_timeout`, or
   *                                   `js_rendering_disabled`.
   *   - `AuthenticationError`       — missing or invalid API key.
   */
  async extract(url: string, options: ExtractOptions = {}): Promise<ExtractResult> {
    const body = await this.request("POST", "/extract", {
      url,
      render_js: options.renderJs === true,
    });
    return extractResultFromResponse(body as Record<string, unknown>);
  }

  /**
   * Submit a batch of URLs for concurrent extraction.
   *
   * Returns immediately with `status="queued"`. Poll with `getJob` or
   * block with `waitForJob` to collect results.
   *
   * Throws:
   *   - `PermissionDeniedError`     — `plan_not_supported` (Free tier).
   *   - `UnprocessableEntityError`  — `bulk_cap_exceeded` (50 on Pro, 200 on Growth).
   *   - `RateLimitError`            — would exceed remaining monthly quota.
   */
  async bulk(urls: Iterable<string>, options: BulkOptions = {}): Promise<BulkJob> {
    const urlList = Array.from(urls);
    if (urlList.length === 0) {
      throw new Error("bulk() requires at least one URL.");
    }
    const payload: Record<string, unknown> = {
      urls: urlList,
      render_js: options.renderJs === true,
    };
    if (options.webhookUrl !== undefined) {
      payload.webhook_url = options.webhookUrl;
      payload.webhook_include_results = options.webhookIncludeResults === true;
    }
    const body = await this.request("POST", "/bulk", payload);
    return bulkJobFromResponse(body as Record<string, unknown>);
  }

  /**
   * Polymorphic job lookup — works for both bulk and crawl jobs.
   *
   * Calls `GET /bulk/{jobId}` first, then inspects the response's `kind`
   * discriminator field. If the job is actually a crawl, a second request
   * to `GET /crawl/{jobId}` fetches the full crawl shape (with per-item
   * depth and the truncated flags). Returns `BulkJob` or `CrawlJob`
   * accordingly.
   *
   * Use `isCrawlJob(job)` (or check `job.kind === "crawl"`) to branch on
   * crawl-specific behavior. The shared interface (`status`, `completed`,
   * `total`, `results`, `done`) works on either type.
   *
   * Jobs are retained for 6 hours after completion.
   */
  async getJob(jobId: string): Promise<BulkJob | CrawlJob> {
    const body = (await this.request("GET", `/bulk/${jobId}`)) as Record<
      string,
      unknown
    >;
    // /bulk/{id} answers for any jobId today (the endpoint just serializes
    // results in the bulk shape regardless of stored job_type). The `kind`
    // field tells us whether we got a bulk-shaped response of a crawl
    // job; if so, re-fetch via /crawl/{id} for the proper shape.
    if (body.kind === "crawl") {
      const crawlBody = (await this.request("GET", `/crawl/${jobId}`)) as Record<
        string,
        unknown
      >;
      return crawlJobFromResponse(crawlBody);
    }
    return bulkJobFromResponse(body);
  }

  /**
   * Block until a job reaches `status="done"` (or timeout). Works for both
   * bulk and crawl jobs.
   *
   * The first call uses the polymorphic `getJob` to discover the job's
   * kind. Subsequent polls go directly to the typed endpoint, so a crawl
   * job only pays the dispatch round-trip once.
   *
   * Throws:
   *   - `Error` with message "did not finish within ..." — the job didn't
   *     finish before `timeoutMs` elapsed.
   */
  async waitForJob(
    jobId: string,
    options: WaitForJobOptions = {},
  ): Promise<BulkJob | CrawlJob> {
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    const timeoutMs = options.timeoutMs === undefined ? 300_000 : options.timeoutMs;
    const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;

    let job: BulkJob | CrawlJob = await this.getJob(jobId);
    const isCrawl = job.kind === "crawl";

    while (!job.done) {
      if (deadline !== null && Date.now() >= deadline) {
        throw new Error(
          `Job ${jobId} did not finish within ${timeoutMs}ms ` +
            `(last status: ${job.status}, ${job.completed}/${job.total})`,
        );
      }
      await sleep(pollIntervalMs);
      const path = isCrawl ? `/crawl/${jobId}` : `/bulk/${jobId}`;
      const body = (await this.request("GET", path)) as Record<string, unknown>;
      job = isCrawl ? crawlJobFromResponse(body) : bulkJobFromResponse(body);
    }
    return job;
  }

  /**
   * Crawl a site starting from `url`, BFS to `depth`.
   *
   * Returns immediately with `status="queued"`. Use `getJob` to poll, or
   * `waitForJob` to block until done — both handle crawl and bulk jobIds
   * transparently.
   *
   * Plan caps:
   *   - Free        → `PermissionDeniedError` (`plan_not_supported`)
   *   - Pro         → max depth 5, up to 2,000 pages per crawl
   *   - Growth      → max depth 10, up to 10,000 pages per crawl
   *   - Enterprise  → unlimited depth and pages
   *
   * Throws:
   *   - `PermissionDeniedError`     — `plan_not_supported` (Free tier).
   *   - `UnprocessableEntityError`  — `crawl_depth_exceeded`.
   */
  async crawl(url: string, options: CrawlOptions = {}): Promise<CrawlJob> {
    const depth = options.depth ?? 1;
    if (depth < 0) {
      throw new Error("depth must be >= 0.");
    }
    const payload: Record<string, unknown> = {
      url,
      depth,
      render_js: options.renderJs === true,
    };
    if (options.webhookUrl !== undefined) {
      payload.webhook_url = options.webhookUrl;
      payload.webhook_include_results = options.webhookIncludeResults === true;
    }
    const body = await this.request("POST", "/crawl", payload);
    return crawlJobFromResponse(body as Record<string, unknown>);
  }

  // ── Custom headers ─────────────────────────────────────────────────────────

  /**
   * Add or replace a per-request header for the rest of this client's life.
   *
   * Authorization / Content-Type / Accept are reserved — calls that try
   * to set those are silently ignored. To rotate the bearer token, use
   * `rotateKey()`.
   */
  setHeader(name: string, value: string): void {
    if (RESERVED_HEADERS.has(name.toLowerCase())) return;
    this.extraHeaders[name] = value;
  }

  /** Remove a header previously added via `headers:` or `setHeader()`. */
  removeHeader(name: string): void {
    delete this.extraHeaders[name];
  }

  /**
   * Return your usage for the current billing period.
   *
   * Does not count toward your monthly quota.
   */
  async getUsage(): Promise<Usage> {
    const body = await this.request("GET", "/usage");
    return usageFromResponse(body as Record<string, unknown>);
  }

  /**
   * Mint a new API key. The current key is invalidated immediately.
   *
   * The new raw key is in the returned `apiKey` field — store it before
   * discarding the result. There is no recovery flow.
   *
   * The client auto-swaps to the new key for subsequent requests.
   *
   * Does not count toward your monthly quota.
   */
  async rotateKey(): Promise<RotatedKey> {
    const body = await this.request("POST", "/keys/rotate");
    const rotated = rotatedKeyFromResponse(body as Record<string, unknown>);
    if (rotated.apiKey) {
      this.apiKey = rotated.apiKey;
    }
    return rotated;
  }

  /**
   * Mint a new webhook signing secret. The current secret is invalidated
   * immediately.
   *
   * Use this when you've lost the secret returned in the
   * `webhookSigningSecret` field of an earlier `bulk()` / `crawl()`
   * response, or when you suspect compromise. Deliveries already in
   * the retry queue will be signed with the NEW secret on their next
   * attempt.
   *
   * Does not count toward your monthly quota.
   */
  async rotateWebhookSecret(): Promise<RotatedWebhookSecret> {
    const body = await this.request("POST", "/webhook/rotate");
    return rotatedWebhookSecretFromResponse(body as Record<string, unknown>);
  }

  /**
   * Internal: read the current API key. Exposed for tests.
   * Not part of the public, semver-stable surface.
   */
  _getApiKey(): string {
    return this.apiKey;
  }

  // ── Transport ──────────────────────────────────────────────────────────────

  private async request(
    method: string,
    path: string,
    json?: unknown,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers = mergeHeaders(this.apiKey, this.extraHeaders);

    const init: RequestInitWithSignal = { method, headers };
    if (json !== undefined) {
      init.body = JSON.stringify(json);
    }

    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (this.timeoutMs > 0 && typeof AbortController !== "undefined") {
      controller = new AbortController();
      init.signal = controller.signal;
      timer = setTimeout(() => controller!.abort(), this.timeoutMs);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init as RequestInit);
    } catch (err) {
      throw new APIConnectionError(
        `Could not reach the WellMarked API: ${stringifyError(err)}`,
        { cause: err },
      );
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch (err) {
      throw new APIConnectionError(
        `Could not read API response body: ${stringifyError(err)}`,
        { cause: err },
      );
    }

    let body: unknown = null;
    if (bodyText.length > 0) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = null;
      }
    }

    return parseResponse(response.status, body, response.headers);
  }
}

function parseResponse(
  statusCode: number,
  body: unknown,
  headers?: Headers,
): unknown {
  let requestId: string | undefined;
  if (body && typeof body === "object") {
    const rid = (body as { request_id?: unknown }).request_id;
    if (typeof rid === "string") requestId = rid;
  }

  if (statusCode >= 200 && statusCode < 300) {
    if (body === null) {
      // The API contract says every documented endpoint returns a JSON
      // body on 2xx. A null body means the server broke that contract
      // (or a middlebox stripped it); fail loudly rather than letting
      // downstream parsing crash on `body.foo` of null.
      throw new WellMarkedError(
        `API returned HTTP ${statusCode} with no JSON body. ` +
          "This is a contract violation — please report it.",
        { statusCode },
      );
    }
    return body;
  }

  // Pass headers through so fromResponse can read Retry-After-Ms on
  // rate-limit 429s — RateLimitError.retryAfterMs lets callers back
  // off with sub-second precision instead of rounding up.
  throw fromResponse(statusCode, body, requestId, headers);
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

// Re-export the APIStatusError type so consumers can narrow without
// pulling from "./errors" directly.
export { APIStatusError };
