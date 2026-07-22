/**
 * Typed response objects returned by the WellMarked SDK.
 *
 * These mirror the JSON shapes documented at https://api.wellmarked.io/docs.
 *
 * Response objects carry only the body fields documented in the API
 * reference — they do not surface HTTP headers. Quota state lives on the
 * account, so use `WellMarked.getUsage()` to read it.
 */

function parseDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── Extraction ───────────────────────────────────────────────────────────────

/**
 * Per-article metadata returned with each extraction.
 *
 * `date` is the article's published date as a string (often `null` — not
 * every page publishes one). `retrievedAt` is the timestamp at which
 * WellMarked actually fetched the page, populated on every successful
 * extraction. The two fields are independent.
 */
export interface ExtractionMeta {
  url: string;
  title: string | null;
  author: string | null;
  date: string | null;
  retrievedAt: Date | null;
}

export function extractionMetaFromDict(data: Record<string, unknown>): ExtractionMeta {
  return {
    url: typeof data.url === "string" ? data.url : "",
    title: typeof data.title === "string" ? data.title : null,
    author: typeof data.author === "string" ? data.author : null,
    date: typeof data.date === "string" ? data.date : null,
    retrievedAt: parseDate(data.retrieved_at),
  };
}

// ── Output formats ───────────────────────────────────────────────────────────

/** Output format for `extract` / `bulk` / `crawl`. */
export type OutputFormat = "markdown" | "json" | "chunks" | "html" | "links";

/** One typed block of a `format: "json"` document. */
export interface ContentBlock {
  type: "heading" | "paragraph" | "list" | "code";
  text: string;
  /** 1-6 for headings; null for every other type. */
  level: number | null;
}

/**
 * One token window of a `format: "chunks"` document.
 *
 * Offsets index into the document's token stream and are contiguous —
 * `chunks[i].endToken === chunks[i + 1].startToken` — so joining every `text`
 * reproduces exactly what `format: "markdown"` would have returned. Windows are
 * 500 tokens except where that would bisect a multi-byte character, in which
 * case they run a token or two longer.
 */
export interface Chunk {
  text: string;
  startToken: number;
  endToken: number;
}

/**
 * How much the extraction reduced the page, in tokens.
 *
 * `tokensSaved` is `inputTokens - outputTokens`: what you did NOT have to send
 * a model versus feeding it the raw HTML. Every token field is null if the API
 * could not load its tokenizer — the extraction still succeeds, the metrics
 * just go unreported.
 */
export interface ContentMetrics {
  contentBytes: number;
  inputTokens: number | null;
  outputTokens: number | null;
  tokensSaved: number | null;
  reductionPct: number | null;
}

/**
 * The format-dependent content fields shared by every extraction result.
 *
 * Exactly one of `markdown`/`blocks`/`chunks`/`html`/`links` is populated —
 * whichever the request's `format` selected. `markdown` is the default, so code
 * written before formats existed keeps working unchanged.
 */
export interface Content {
  markdown: string | null;
  blocks: ContentBlock[] | null;
  chunks: Chunk[] | null;
  html: string | null;
  links: string[] | null;
  metrics: ContentMetrics | null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function contentFromDict(data: Record<string, unknown>): Content {
  const rawBlocks = data.blocks;
  const rawChunks = data.chunks;
  const rawMetrics = data.metrics;
  const rawLinks = data.links;

  return {
    markdown: typeof data.markdown === "string" ? data.markdown : null,
    blocks: Array.isArray(rawBlocks)
      ? rawBlocks.map((b) => {
          const o = b as Record<string, unknown>;
          return {
            type: (typeof o.type === "string" ? o.type : "paragraph") as ContentBlock["type"],
            text: typeof o.text === "string" ? o.text : "",
            level: numOrNull(o.level),
          };
        })
      : null,
    chunks: Array.isArray(rawChunks)
      ? rawChunks.map((c) => {
          const o = c as Record<string, unknown>;
          return {
            text: typeof o.text === "string" ? o.text : "",
            startToken: typeof o.start_token === "number" ? o.start_token : 0,
            endToken: typeof o.end_token === "number" ? o.end_token : 0,
          };
        })
      : null,
    html: typeof data.html === "string" ? data.html : null,
    links: Array.isArray(rawLinks) ? rawLinks.filter((l): l is string => typeof l === "string") : null,
    metrics:
      rawMetrics && typeof rawMetrics === "object"
        ? (() => {
            const m = rawMetrics as Record<string, unknown>;
            return {
              contentBytes: typeof m.content_bytes === "number" ? m.content_bytes : 0,
              inputTokens: numOrNull(m.input_tokens),
              outputTokens: numOrNull(m.output_tokens),
              tokensSaved: numOrNull(m.tokens_saved),
              reductionPct: numOrNull(m.reduction_pct),
            };
          })()
        : null,
  };
}

/**
 * Whichever content field the response actually populated, or null.
 *
 * Handy when you don't care which format came back; read the specific field
 * when you need a precise static type.
 */
export function contentOf(item: Content): string | ContentBlock[] | Chunk[] | string[] | null {
  return item.markdown ?? item.blocks ?? item.chunks ?? item.html ?? item.links ?? null;
}

/**
 * Result of `POST /extract`.
 *
 * `markdown` is populated for the default `format: "markdown"`; other formats
 * populate their own field instead (see `Content`).
 */
export interface ExtractResult extends Content {
  metadata: ExtractionMeta;
  requestId: string;
}

export function extractResultFromResponse(body: Record<string, unknown>): ExtractResult {
  const rawMeta =
    body.metadata && typeof body.metadata === "object"
      ? (body.metadata as Record<string, unknown>)
      : {};
  return {
    ...contentFromDict(body),
    metadata: extractionMetaFromDict(rawMeta),
    requestId: typeof body.request_id === "string" ? body.request_id : "",
  };
}

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * One result in a `SearchResults`.
 *
 * On success `status === "ok"` and `markdown` is populated; on a per-page
 * failure `status === "error"` and `error` carries a stable code (same
 * convention as `BulkItem.error`). `title` is the extracted title on success,
 * else the search provider's; `snippet` is always the provider's result
 * snippet, so a page that failed extraction still carries context.
 */
export interface SearchResult extends Content {
  url: string;
  status: "ok" | "error";
  title: string | null;
  snippet: string | null;
  error: string | null;
  /** True when `status === "ok"`. */
  readonly ok: boolean;
}

export function searchResultFromDict(data: Record<string, unknown>): SearchResult {
  const url = typeof data.url === "string" ? data.url : "";
  const status: "ok" | "error" = data.status === "ok" ? "ok" : "error";
  const title = typeof data.title === "string" ? data.title : null;
  const snippet = typeof data.snippet === "string" ? data.snippet : null;
  const error = typeof data.error === "string" ? data.error : null;
  return {
    ...contentFromDict(data),
    url,
    status,
    title,
    snippet,
    error,
    get ok(): boolean {
      return this.status === "ok";
    },
  };
}

/**
 * Result of `POST /search` — the query plus the extracted result pages.
 * Synchronous: unlike bulk/crawl there is no job to poll; `results` is already
 * populated, with partial failures marked per item.
 */
export interface SearchResults {
  query: string;
  results: SearchResult[];
  requestId: string;
}

export function searchResultsFromResponse(body: Record<string, unknown>): SearchResults {
  const rawResults = Array.isArray(body.results) ? body.results : [];
  const results = rawResults
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
    .map(searchResultFromDict);
  return {
    query: typeof body.query === "string" ? body.query : "",
    results,
    requestId: typeof body.request_id === "string" ? body.request_id : "",
  };
}

// ── Bulk ─────────────────────────────────────────────────────────────────────

/**
 * One entry in a bulk job's `results` list.
 *
 * On success, `markdown` and `metadata` are populated and `error` is null.
 * On a per-URL failure, `markdown`/`metadata` are null and `error` carries a
 * stable API error *code* — never a human message — e.g. `target_timeout`,
 * `domain_denied`, `internal_error`. Same convention as `CrawlItem.error`, so
 * results parse identically on either endpoint.
 */
export interface BulkItem extends Content {
  url: string;
  metadata: ExtractionMeta | null;
  error: string | null;
  /** True when the item completed successfully (no error + has content). */
  readonly ok: boolean;
}

export function bulkItemFromDict(data: Record<string, unknown>): BulkItem {
  const rawMeta = data.metadata;
  const url = typeof data.url === "string" ? data.url : "";
  const error = typeof data.error === "string" ? data.error : null;
  const metadata =
    rawMeta && typeof rawMeta === "object"
      ? extractionMetaFromDict(rawMeta as Record<string, unknown>)
      : null;
  // `ok` reads from `this` rather than a captured local so it tracks any
  // post-construction mutation of `error` / the content fields. Previously the
  // getter closed over the initial values and lied about state if either
  // field was reassigned later.
  //
  // It keys on `error` + contentOf, NOT on `markdown`: a non-markdown format
  // leaves markdown null on a perfectly successful item.
  return {
    ...contentFromDict(data),
    url,
    metadata,
    error,
    get ok(): boolean {
      return this.error === null && contentOf(this) !== null;
    },
  };
}

/** "queued" | "processing" | "done" */
export type JobStatus = "queued" | "processing" | "done";

/**
 * Status of a bulk extraction job.
 *
 * Returned from both `POST /bulk` and `GET /bulk/{jobId}`. Also one of the
 * two possible return types from the polymorphic `WellMarked.getJob` and
 * `WellMarked.waitForJob` — use the `kind` discriminator (or a type guard)
 * to distinguish from `CrawlJob` if you need to read crawl-specific fields.
 */
export interface BulkJob {
  readonly kind: "bulk";
  jobId: string;
  status: JobStatus;
  total: number;
  completed: number;
  results: BulkItem[];
  createdAt: Date | null;
  finishedAt: Date | null;
  /**
   * Populated ONLY on the submission that first minted this account's
   * webhook signing secret (one-time visibility, Stripe-style). Always
   * null on poll responses. Save it on receipt and pass it to
   * `verifyWebhook`; if you lose it, call `rotateWebhookSecret`.
   */
  webhookSigningSecret: string | null;
  /** True when `status === "done"`. */
  readonly done: boolean;
}

export function bulkJobFromResponse(body: Record<string, unknown>): BulkJob {
  const rawResults = Array.isArray(body.results) ? body.results : [];
  const status =
    typeof body.status === "string" ? (body.status as JobStatus) : "queued";
  const jobId = typeof body.job_id === "string" ? body.job_id : "";
  const total = typeof body.total === "number" ? body.total : 0;
  const completed = typeof body.completed === "number" ? body.completed : 0;
  const createdAt = parseDate(body.created_at);
  const finishedAt = parseDate(body.finished_at);
  const results = rawResults
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
    .map(bulkItemFromDict);
  const webhookSigningSecret =
    typeof body.webhook_signing_secret === "string"
      ? body.webhook_signing_secret
      : null;
  // See BulkItem.ok — the getter reads `this.status` rather than the
  // closed-over local so a caller who reassigns `job.status` still sees a
  // truthful `job.done`.
  return {
    kind: "bulk",
    jobId,
    status,
    total,
    completed,
    results,
    createdAt,
    finishedAt,
    webhookSigningSecret,
    get done(): boolean {
      return this.status === "done";
    },
  };
}

// ── Crawl ────────────────────────────────────────────────────────────────────

/**
 * One page in a crawl job's `results` list.
 *
 * Shape mirrors `BulkItem` with an added `depth` field showing how far
 * from the root URL this page sits in the BFS.
 */
export interface CrawlItem extends Content {
  url: string;
  depth: number;
  metadata: ExtractionMeta | null;
  error: string | null;
  /** True when the page completed successfully (no error + has content). */
  readonly ok: boolean;
}

export function crawlItemFromDict(data: Record<string, unknown>): CrawlItem {
  const rawMeta = data.metadata;
  const url = typeof data.url === "string" ? data.url : "";
  const depth = typeof data.depth === "number" ? data.depth : 0;
  const error = typeof data.error === "string" ? data.error : null;
  const metadata =
    rawMeta && typeof rawMeta === "object"
      ? extractionMetaFromDict(rawMeta as Record<string, unknown>)
      : null;
  // See BulkItem.ok — same `this`-based getter, same content-not-markdown key.
  return {
    ...contentFromDict(data),
    url,
    depth,
    metadata,
    error,
    get ok(): boolean {
      return this.error === null && contentOf(this) !== null;
    },
  };
}

export type TruncatedReason = "page_cap_reached" | "quota_exhausted";

/**
 * Status of a crawl job. Returned from `POST /crawl` and `GET /crawl/{jobId}`.
 *
 * Two crawl-only fields:
 *   - `truncated`        — true when the crawl stopped before exhausting
 *                          the frontier (depth/page cap or quota).
 *   - `truncatedReason`  — `"page_cap_reached"` | `"quota_exhausted"` |
 *                          `null`.
 */
export interface CrawlJob {
  readonly kind: "crawl";
  jobId: string;
  status: JobStatus;
  total: number;
  completed: number;
  results: CrawlItem[];
  truncated: boolean;
  truncatedReason: TruncatedReason | null;
  createdAt: Date | null;
  finishedAt: Date | null;
  /** See `BulkJob.webhookSigningSecret` — same semantics here. */
  webhookSigningSecret: string | null;
  /** True when `status === "done"`. */
  readonly done: boolean;
}

export function crawlJobFromResponse(body: Record<string, unknown>): CrawlJob {
  const rawResults = Array.isArray(body.results) ? body.results : [];
  const status =
    typeof body.status === "string" ? (body.status as JobStatus) : "queued";
  const jobId = typeof body.job_id === "string" ? body.job_id : "";
  const total = typeof body.total === "number" ? body.total : 0;
  const completed = typeof body.completed === "number" ? body.completed : 0;
  const createdAt = parseDate(body.created_at);
  const finishedAt = parseDate(body.finished_at);
  const truncated = body.truncated === true;
  const truncatedReason =
    typeof body.truncated_reason === "string"
      ? (body.truncated_reason as TruncatedReason)
      : null;
  const results = rawResults
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
    .map(crawlItemFromDict);
  const webhookSigningSecret =
    typeof body.webhook_signing_secret === "string"
      ? body.webhook_signing_secret
      : null;
  // See BulkJob.done — `this.status` so mutation isn't lost.
  return {
    kind: "crawl",
    jobId,
    status,
    total,
    completed,
    results,
    truncated,
    truncatedReason,
    createdAt,
    finishedAt,
    webhookSigningSecret,
    get done(): boolean {
      return this.status === "done";
    },
  };
}

// ── Usage ────────────────────────────────────────────────────────────────────

/**
 * Result of `GET /usage` — current-period quota state.
 *
 * This is the source of truth for rate-limit / quota information. The SDK
 * does not surface `X-RateLimit-*` headers on extract/bulk responses;
 * call `WellMarked.getUsage()` instead.
 */
export interface Usage {
  plan: string;
  period: string;
  used: number;
  limit: number;
  remaining: number;
}

export function usageFromResponse(body: Record<string, unknown>): Usage {
  return {
    plan: typeof body.plan === "string" ? body.plan : "",
    period: typeof body.period === "string" ? body.period : "",
    used: typeof body.used === "number" ? body.used : 0,
    limit: typeof body.limit === "number" ? body.limit : 0,
    remaining: typeof body.remaining === "number" ? body.remaining : 0,
  };
}

// ── Key rotation ─────────────────────────────────────────────────────────────

/**
 * Result of `POST /keys/rotate`.
 *
 * `apiKey` is the new raw key — store it before discarding this object,
 * there is no recovery flow. The previous key is invalidated the moment
 * the rotation call returns 200.
 */
export interface RotatedKey {
  apiKey: string;
  rotatedAt: Date | null;
}

export function rotatedKeyFromResponse(body: Record<string, unknown>): RotatedKey {
  return {
    apiKey: typeof body.api_key === "string" ? body.api_key : "",
    rotatedAt: parseDate(body.rotated_at),
  };
}

// ── Webhook secret rotation ──────────────────────────────────────────────────

/**
 * Result of `POST /webhook/rotate`.
 *
 * `webhookSigningSecret` is the new raw secret — store it before
 * discarding this object, there is no recovery flow other than
 * rotating again. The previous secret is invalidated the moment the
 * rotation call returns 200, and any deliveries already in the retry
 * queue will be signed with the NEW secret on their next attempt.
 */
export interface RotatedWebhookSecret {
  webhookSigningSecret: string;
  rotatedAt: Date | null;
}

export function rotatedWebhookSecretFromResponse(
  body: Record<string, unknown>,
): RotatedWebhookSecret {
  return {
    webhookSigningSecret:
      typeof body.webhook_signing_secret === "string"
        ? body.webhook_signing_secret
        : "",
    rotatedAt: parseDate(body.rotated_at),
  };
}

// ── Self-registration ────────────────────────────────────────────────────────

/**
 * Result of `WellMarked.register` (`POST /register`).
 *
 * `apiKey` is the new raw key — shown once, store it. The account is
 * deliberately weak: `plan === "free"` and `scopes === ["extract"]`. Build a
 * client with it via `new WellMarked({ apiKey: account.apiKey })`.
 */
export interface RegisteredAccount {
  apiKey: string;
  userId: string;
  plan: string;
  scopes: string[];
}

export function registeredAccountFromResponse(
  body: Record<string, unknown>,
): RegisteredAccount {
  return {
    apiKey: typeof body.api_key === "string" ? body.api_key : "",
    userId: typeof body.user_id === "string" ? body.user_id : "",
    plan: typeof body.plan === "string" ? body.plan : "",
    scopes: Array.isArray(body.scopes) ? (body.scopes as string[]) : [],
  };
}

// ── Key management (scoped keys) ─────────────────────────────────────────────

/**
 * Result of `createKey` (`POST /keys`). `apiKey` is the new raw key — shown
 * once, store it before discarding this object. `scopes` is the subset it was
 * granted (extract / bulk / crawl / keys).
 */
export interface CreatedKey {
  id: string;
  apiKey: string;
  name: string;
  scopes: string[];
  createdAt: Date | null;
}

export function createdKeyFromResponse(body: Record<string, unknown>): CreatedKey {
  return {
    id: typeof body.id === "string" ? body.id : "",
    apiKey: typeof body.api_key === "string" ? body.api_key : "",
    name: typeof body.name === "string" ? body.name : "",
    scopes: Array.isArray(body.scopes) ? (body.scopes as string[]) : [],
    createdAt: parseDate(body.created_at),
  };
}

/**
 * One key's metadata from `listKeys` (`GET /keys`). Never carries the raw key.
 * `revokedAt` is set once the key has been revoked; `active` is a convenience.
 */
export interface ApiKeyInfo {
  id: string;
  name: string;
  scopes: string[];
  createdAt: Date | null;
  revokedAt: Date | null;
  readonly active: boolean;
}

export function apiKeyInfoFromDict(data: Record<string, unknown>): ApiKeyInfo {
  return {
    id: typeof data.id === "string" ? data.id : "",
    name: typeof data.name === "string" ? data.name : "",
    scopes: Array.isArray(data.scopes) ? (data.scopes as string[]) : [],
    createdAt: parseDate(data.created_at),
    revokedAt: parseDate(data.revoked_at),
    get active(): boolean {
      return this.revokedAt === null;
    },
  };
}

/** Result of `revokeKey` (`DELETE /keys/{id}`). */
export interface RevokedKey {
  id: string;
  revokedAt: Date | null;
}

export function revokedKeyFromResponse(body: Record<string, unknown>): RevokedKey {
  return {
    id: typeof body.id === "string" ? body.id : "",
    revokedAt: parseDate(body.revoked_at),
  };
}

// ── Audit log ────────────────────────────────────────────────────────────────

/**
 * One row of your request history from `getLogs` (`GET /logs`).
 *
 * `policyDecision` records how the key's compliance policy decided:
 * `"allowed"` | `"domain_not_allowed"` | `"domain_denied"` |
 * `"robots_disallowed"`. `keyId` attributes the request to a key.
 */
export interface LogEntry {
  id: string;
  timestamp: Date | null;
  targetUrl: string;
  statusCode: number;
  durationMs: number;
  errorCode: string | null;
  renderJs: boolean | null;
  keyId: string | null;
  policyDecision: string | null;
}

export function logEntryFromDict(data: Record<string, unknown>): LogEntry {
  return {
    id: typeof data.id === "string" ? data.id : "",
    timestamp: parseDate(data.timestamp),
    targetUrl: typeof data.target_url === "string" ? data.target_url : "",
    statusCode: typeof data.status_code === "number" ? data.status_code : 0,
    durationMs: typeof data.duration_ms === "number" ? data.duration_ms : 0,
    errorCode: typeof data.error_code === "string" ? data.error_code : null,
    renderJs: typeof data.render_js === "boolean" ? data.render_js : null,
    keyId: typeof data.key_id === "string" ? data.key_id : null,
    policyDecision:
      typeof data.policy_decision === "string" ? data.policy_decision : null,
  };
}

/**
 * One page of `getLogs` results. `hasMore` is true when further rows exist
 * beyond this page — advance by `offset += limit`.
 */
export interface LogsPage {
  logs: LogEntry[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export function logsPageFromResponse(body: Record<string, unknown>): LogsPage {
  const rawLogs = Array.isArray(body.logs) ? body.logs : [];
  return {
    logs: rawLogs
      .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
      .map(logEntryFromDict),
    limit: typeof body.limit === "number" ? body.limit : 0,
    offset: typeof body.offset === "number" ? body.offset : 0,
    hasMore: body.has_more === true,
  };
}

// ── Type guards ──────────────────────────────────────────────────────────────

export function isBulkJob(job: BulkJob | CrawlJob): job is BulkJob {
  return job.kind === "bulk";
}

export function isCrawlJob(job: BulkJob | CrawlJob): job is CrawlJob {
  return job.kind === "crawl";
}
