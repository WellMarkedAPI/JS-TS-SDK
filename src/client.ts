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
  type ApiKeyInfo,
  type BulkJob,
  type CrawlJob,
  type CreatedKey,
  type ExtractResult,
  type LogsPage,
  type OutputFormat,
  type RegisteredAccount,
  type RevokedKey,
  type RotatedKey,
  type RotatedWebhookSecret,
  type SearchResults,
  type Usage,
  apiKeyInfoFromDict,
  bulkJobFromResponse,
  crawlJobFromResponse,
  createdKeyFromResponse,
  extractResultFromResponse,
  logsPageFromResponse,
  registeredAccountFromResponse,
  revokedKeyFromResponse,
  rotatedKeyFromResponse,
  rotatedWebhookSecretFromResponse,
  searchResultsFromResponse,
  usageFromResponse,
} from "./models.js";
import { VERSION } from "./version.js";

const DEFAULT_BASE_URL = "https://api.wellmarked.io";
const DEFAULT_TIMEOUT_MS = 30_000;
// 3 attempts total. Enough to ride out a blip; low enough that a genuinely
// down API surfaces quickly instead of stalling the caller for a minute.
const DEFAULT_MAX_RETRIES = 2;

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
  /**
   * Timeout for a single attempt, milliseconds. Defaults to 30000 (30s).
   *
   * This is **per attempt, not per call**. With the default `maxRetries: 2`,
   * a retryable request can therefore take up to roughly
   * `timeoutMs * 3` plus backoff (~92s at the defaults) before it gives up.
   * Lower `maxRetries` if you need a tighter ceiling.
   */
  timeoutMs?: number;
  /**
   * How many times to retry a request the SDK knows is safe to replay.
   * Defaults to 2 (so 3 attempts total). Set 0 to disable.
   *
   * Only connection failures and 5xx responses are retried, and only for
   * requests that can be replayed safely: GETs, and POSTs carrying an
   * `Idempotency-Key` (which `bulk()` and `crawl()` send automatically).
   * A `POST /extract` is never retried — the API bills it on arrival, and a
   * connection error can't tell you whether it arrived.
   *
   * Retries reuse the same Idempotency-Key, so the API replays the original
   * job rather than enqueuing a second one.
   */
  maxRetries?: number;
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

/**
 * Per-request compliance overrides, shared by extract / bulk / crawl. Each can
 * only NARROW the API key's own policy server-side — add denies, restrict to a
 * subset of the key's allowed domains, or upgrade robots to strict — never
 * widen it. An omitted field leaves the key's policy untouched.
 */
export interface PolicyOverrideOptions {
  /** Restrict this request to these domains (and their subdomains). */
  allowDomains?: string[];
  /** Extra deny globs for this request (matched on hostname and full URL). */
  denyPatterns?: string[];
  /** `"strict"` or `"lax"`; can tighten but not loosen the key's setting. */
  respectRobots?: "strict" | "lax";
}

export interface ExtractOptions extends PolicyOverrideOptions {
  /**
   * Use Playwright to render JS-heavy pages. Requires a Pro, Growth, or
   * Enterprise plan; Free returns `plan_not_supported`.
   */
  renderJs?: boolean;
  /**
   * Output format. `"markdown"` (default), `"json"` (typed
   * heading/paragraph/list/code blocks), `"chunks"` (contiguous 500-token
   * windows for embedding), `"html"` (the raw fetched HTML) or `"links"`
   * (every http(s) link found). The result populates the matching field;
   * the others stay null. Use `contentOf(result)` to read whichever it is.
   */
  format?: OutputFormat;
}

/** Options for `search`. */
export interface SearchOptions {
  /**
   * How many results to fetch + extract. Clamped to 1..10 server-side (a
   * search is one synchronous call). Default 5.
   */
  numResults?: number;
  /** Render JS-heavy result pages before extracting. */
  renderJs?: boolean;
}

/** Options for `createKey`. */
export interface CreateKeyOptions {
  /** A label for the key (shown in `listKeys`). Defaults to "default". */
  name?: string;
}

/** Options for the static `WellMarked.register`. */
export interface RegisterOptions {
  /** API base URL. Override for testing. */
  baseUrl?: string;
  /** Timeout for the single request, milliseconds. Defaults to 30000. */
  timeoutMs?: number;
  /** Bring your own `fetch`. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Options for `getLogs`. */
export interface GetLogsOptions {
  /** Page size, 1–200. Defaults to 50. */
  limit?: number;
  /** Row offset for pagination. Defaults to 0. */
  offset?: number;
}

/** Build the snake_case policy-override body fields, omitting unset ones. */
function policyOverrides(o: PolicyOverrideOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (o.allowDomains !== undefined) out.allow_domains = o.allowDomains;
  if (o.denyPatterns !== undefined) out.deny_patterns = o.denyPatterns;
  if (o.respectRobots !== undefined) out.respect_robots = o.respectRobots;
  return out;
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
  /**
   * Sent as the `Idempotency-Key` header, so a replayed submission returns
   * the ORIGINAL job instead of enqueuing a second one and charging your
   * quota twice.
   *
   * A key is generated automatically and reused across the SDK's own internal
   * retries (see `maxRetries`), which covers the common case of a connection
   * blip mid-submission.
   *
   * **Pass your own key to survive anything the SDK can't retry for you** —
   * a process crash, or your code catching the error and calling `bulk()`
   * again. That second call mints a *new* key and gets a *second* job unless
   * you reuse a stable one.
   *
   * Same key + same body replays the original job. Same key + a *different*
   * body throws `UnprocessableEntityError` (`idempotency_key_reuse`) — use a
   * fresh key per distinct submission. Records expire after 6 hours, matching
   * the job TTL.
   *
   * Note the body must match byte-for-byte: reordering `urls` counts as a
   * different request.
   */
  idempotencyKey?: string;
}

export interface BulkOptions extends JobWebhookOptions, PolicyOverrideOptions {
  renderJs?: boolean;
  /**
   * Output format. `"markdown"` (default), `"json"` (typed
   * heading/paragraph/list/code blocks), `"chunks"` (contiguous 500-token
   * windows for embedding), `"html"` (the raw fetched HTML) or `"links"`
   * (every http(s) link found). The result populates the matching field;
   * the others stay null. Use `contentOf(result)` to read whichever it is.
   */
  format?: OutputFormat;
}

export interface CrawlOptions extends JobWebhookOptions, PolicyOverrideOptions {
  /** Max BFS depth from the root. Defaults to 1. Must be >= 0. */
  depth?: number;
  renderJs?: boolean;
  /**
   * Output format. `"markdown"` (default), `"json"` (typed
   * heading/paragraph/list/code blocks), `"chunks"` (contiguous 500-token
   * windows for embedding), `"html"` (the raw fetched HTML) or `"links"`
   * (every http(s) link found). The result populates the matching field;
   * the others stay null. Use `contentOf(result)` to read whichever it is.
   */
  format?: OutputFormat;
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
  perRequest?: Record<string, string>,
): Record<string, string> {
  const out = defaultHeaders(apiKey);
  // Client-wide headers first, then per-request ones — a header passed to a
  // single call wins over the same header set on the client. Both are filtered
  // against RESERVED_HEADERS: a stray Authorization from either source would
  // break rotateKey() mid-session (see RESERVED_HEADERS).
  for (const source of [extra, perRequest]) {
    if (!source) continue;
    for (const [k, v] of Object.entries(source)) {
      if (RESERVED_HEADERS.has(k.toLowerCase())) continue;
      out[k] = v;
    }
  }
  return out;
}

/**
 * Idempotency keys must be unique per logical operation, which is exactly why
 * they can't ride on the client-wide `headers` option: that would pin every
 * subsequent call to the same key. Hence the per-request channel above.
 */
function newIdempotencyKey(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (typeof g.crypto?.randomUUID === "function") return g.crypto.randomUUID();
  // Node 18.17+ and every modern browser have crypto.randomUUID. This is a
  // last resort for exotic runtimes; uniqueness only has to hold within one
  // caller's retry window, not globally.
  return `wm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
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
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: WellMarkedOptions = {}) {
    this.apiKey = resolveApiKey(options.apiKey);
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
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

  // ── Self-registration ───────────────────────────────────────────────────────

  /**
   * Self-register for a free, extract-only API key — no existing key needed.
   *
   * The zero-to-first-call path for an agent that discovered WellMarked
   * programmatically. Returns a `RegisteredAccount` whose `apiKey` is a weak
   * credential (Free plan, `scopes: ["extract"]`); build a client with it:
   *
   *     const account = await WellMarked.register("agent@example.com");
   *     const wm = new WellMarked({ apiKey: account.apiKey });
   *     await wm.extract("https://example.com");
   *
   * Not retried — registration mints an account and isn't idempotent.
   *
   * Throws:
   *   - `RateLimitError`  — `register_rate_limited`: too many from this IP.
   *   - `APIStatusError`  — `email_taken` (409), or `service_unavailable` (503)
   *                         if the limiter backend is momentarily down.
   */
  static async register(
    email: string,
    options: RegisterOptions = {},
  ): Promise<RegisteredAccount> {
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const f = options.fetch ?? (typeof fetch !== "undefined" ? fetch : undefined);
    if (!f) {
      throw new Error(
        "No fetch implementation available. Pass `fetch:` to register() " +
          "(undici, node-fetch, etc.) or upgrade to Node 18+.",
      );
    }
    const fetchImpl = f.bind(globalThis) as typeof fetch;

    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const init: RequestInitWithSignal = {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email }),
    };
    if (timeoutMs > 0 && typeof AbortController !== "undefined") {
      controller = new AbortController();
      init.signal = controller.signal;
      timer = setTimeout(() => controller!.abort(), timeoutMs);
    }

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/register`, init as RequestInit);
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
    const data = parseResponse(response.status, body, response.headers) as Record<
      string,
      unknown
    >;
    return registeredAccountFromResponse(data);
  }

  // ── Endpoints ──────────────────────────────────────────────────────────────

  /**
   * Extract clean Markdown from a single URL.
   *
   * Throws:
   *   - `RateLimitError`            — monthly plan limit reached.
   *   - `PermissionDeniedError`     — `plan_not_supported`: `renderJs=true`
   *                                   on the Free plan.
   *   - `UnprocessableEntityError`  — `no_content` or `target_timeout`.
   *   - `AuthenticationError`       — missing or invalid API key.
   */
  async extract(url: string, options: ExtractOptions = {}): Promise<ExtractResult> {
    const body = await this.request("POST", "/extract", {
      url,
      render_js: options.renderJs === true,
      format: options.format ?? "markdown",
      ...policyOverrides(options),
    });
    return extractResultFromResponse(body as Record<string, unknown>);
  }

  /**
   * Search the web and extract each result to Markdown. Synchronous — one
   * round trip, no job to poll.
   *
   * The query runs against the search provider and the result pages are
   * extracted concurrently, returned together with a per-page `status` (a slow
   * or blocked page becomes an error item, never sinks the call). Costs
   * `1 + results.length` requests — one for the query, one per page returned.
   *
   * Throws:
   *   - `PermissionDeniedError`    — `plan_not_supported`: search requires a
   *                                  Pro, Growth, or Enterprise plan.
   *   - `RateLimitError`           — would exceed remaining monthly quota.
   *   - `InternalServerError`      — the provider is unconfigured or
   *                                  unreachable (`code === "service_unavailable"`).
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResults> {
    const body = await this.request("POST", "/search", {
      query,
      num_results: options.numResults ?? 5,
      render_js: options.renderJs === true,
    });
    return searchResultsFromResponse(body as Record<string, unknown>);
  }

  /**
   * Submit a batch of URLs for concurrent extraction.
   *
   * Returns immediately with `status="queued"`. Poll with `getJob` or
   * block with `waitForJob` to collect results.
   *
   * An `Idempotency-Key` is generated per call and reused across the SDK's
   * internal retries, so a connection blip replays the original job rather
   * than enqueuing a second one. To be safe against retries *your own code*
   * makes, pass a stable `idempotencyKey` — see `BulkOptions.idempotencyKey`.
   *
   * Throws:
   *   - `PermissionDeniedError`     — `plan_not_supported`: `renderJs=true`
   *                                   on the Free plan.
   *   - `UnprocessableEntityError`  — `bulk_cap_exceeded` (5 on Free, 50 on
   *                                   Pro, 200 on Growth), or
   *                                   `idempotency_key_reuse` if the key was
   *                                   already used for a different body.
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
      format: options.format ?? "markdown",
      ...policyOverrides(options),
    };
    if (options.webhookUrl !== undefined) {
      payload.webhook_url = options.webhookUrl;
      payload.webhook_include_results = options.webhookIncludeResults === true;
    }
    const body = await this.request("POST", "/bulk", payload, {
      "Idempotency-Key": options.idempotencyKey ?? newIdempotencyKey(),
    });
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
      format: options.format ?? "markdown",
      ...policyOverrides(options),
    };
    if (options.webhookUrl !== undefined) {
      payload.webhook_url = options.webhookUrl;
      payload.webhook_include_results = options.webhookIncludeResults === true;
    }
    const body = await this.request("POST", "/crawl", payload, {
      "Idempotency-Key": options.idempotencyKey ?? newIdempotencyKey(),
    });
    return crawlJobFromResponse(body as Record<string, unknown>);
  }

  // ── Custom headers ─────────────────────────────────────────────────────────

  /**
   * Add or replace a header for the rest of this client's life.
   *
   * Client-wide, so it is the wrong place for `Idempotency-Key`: that must be
   * unique per submission, and pinning one here would make every later
   * `bulk()` / `crawl()` replay the first job. Pass `idempotencyKey` to those
   * methods instead (they generate one per call by default).
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

  // ── Key management (scoped keys) ─────────────────────────────────────────────

  /**
   * Mint a new scoped API key on this account.
   *
   * `scopes` is a non-empty subset of `extract`, `bulk`, `crawl`, `keys`; the
   * calling key can only grant scopes it holds. The raw key is in the returned
   * `apiKey` — store it, it's shown once. Requires the `keys` scope. Does not
   * count toward your quota.
   *
   * Throws:
   *   - `PermissionDeniedError`     — `insufficient_scope`: your key lacks
   *                                   `keys`, or a scope it doesn't hold.
   *   - `UnprocessableEntityError`  — `invalid_request`: empty/unknown scopes.
   */
  async createKey(scopes: string[], options: CreateKeyOptions = {}): Promise<CreatedKey> {
    const body = await this.request("POST", "/keys", {
      scopes,
      name: options.name ?? "default",
    });
    return createdKeyFromResponse(body as Record<string, unknown>);
  }

  /**
   * List this account's keys (metadata only — never the raw values), including
   * revoked ones (`revokedAt` set). Requires the `keys` scope. Does not count
   * toward your quota.
   */
  async listKeys(): Promise<ApiKeyInfo[]> {
    const body = (await this.request("GET", "/keys")) as Record<string, unknown>;
    const raw = Array.isArray(body.keys) ? body.keys : [];
    return raw
      .filter((k): k is Record<string, unknown> => k !== null && typeof k === "object")
      .map(apiKeyInfoFromDict);
  }

  /**
   * Revoke a key by id — it stops authenticating immediately. Idempotent.
   * Requires the `keys` scope. Does not count toward your quota.
   *
   * Throws `NotFoundError` (`key_not_found`) if no such key exists on this
   * account.
   */
  async revokeKey(keyId: string): Promise<RevokedKey> {
    const body = await this.request("DELETE", `/keys/${keyId}`);
    return revokedKeyFromResponse(body as Record<string, unknown>);
  }

  // ── Audit log ────────────────────────────────────────────────────────────────

  /**
   * Return this account's request history, newest first — the audit trail
   * (which key ran each call and how its policy decided). Own rows only.
   * Paginate via `offset += limit` while `hasMore` is true. Does not count
   * toward your quota.
   */
  async getLogs(options: GetLogsOptions = {}): Promise<LogsPage> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const body = await this.request(
      "GET",
      `/logs?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`,
    );
    return logsPageFromResponse(body as Record<string, unknown>);
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
    perRequestHeaders?: Record<string, string>,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers = mergeHeaders(this.apiKey, this.extraHeaders, perRequestHeaders);

    // Only replay a request when replaying it is actually safe.
    //
    // A connection error is ambiguous: the request may well have reached the
    // API and been executed — we just never saw the response. Blindly retrying
    // a POST /extract would extract (and bill) twice. GETs are naturally safe,
    // and a POST is safe exactly when it carries an Idempotency-Key, because
    // then the API replays the original job instead of creating a second one.
    //
    // This is what makes the auto-generated key on bulk()/crawl() worth
    // anything: the key is reused across THESE attempts, so all of them
    // collapse to one job. A caller who catches an error and calls bulk()
    // again still mints a new key and gets a second job — that's why the
    // docs tell you to pass your own key for retries across calls.
    //
    // Note this inspects `perRequestHeaders`, NOT the merged set.
    // Idempotency-Key is not a RESERVED_HEADER, so a caller can legally
    // `setHeader("Idempotency-Key", ...)` client-wide — and reading the merged
    // headers would then mark POST /extract replay-safe and retry it, billing
    // twice. Only a key this call actually attached counts.
    const safeToReplay =
      method.toUpperCase() === "GET" ||
      Object.keys(perRequestHeaders ?? {}).some(
        (h) => h.toLowerCase() === "idempotency-key",
      );
    const attempts = safeToReplay ? this.maxRetries + 1 : 1;

    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt));

      const init: RequestInitWithSignal = { method, headers };
      if (json !== undefined) {
        init.body = JSON.stringify(json);
      }

      // A fresh controller per attempt: reusing an aborted signal would make
      // every retry fail instantly.
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
        lastError = new APIConnectionError(
          `Could not reach the WellMarked API: ${stringifyError(err)}`,
          { cause: err },
        );
        continue;
      } finally {
        if (timer !== null) clearTimeout(timer);
      }

      // 5xx is the other ambiguous case — the API may have committed the job
      // before failing. 4xx is deterministic: replaying reproduces it, so
      // don't waste the caller's time.
      if (response.status >= 500 && attempt < attempts - 1) {
        lastError = undefined;
        continue;
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

    // Exhausted the retries on a connection error. A 5xx that ran out of
    // attempts fell through to parseResponse above and threw there.
    throw lastError ?? new APIConnectionError("Could not reach the WellMarked API.");
  }
}

/** Exponential backoff with jitter. Jitter matters when an agent fans out —
 * without it, N clients retry in lockstep and hit the API as a thundering
 * herd at exactly the moment it is already struggling. */
function backoffMs(attempt: number): number {
  const base = Math.min(500 * 2 ** (attempt - 1), 4000);
  return base + Math.random() * 250;
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
