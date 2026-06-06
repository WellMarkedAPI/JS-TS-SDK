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

/** Result of `POST /extract`. */
export interface ExtractResult {
  markdown: string;
  metadata: ExtractionMeta;
  requestId: string;
}

export function extractResultFromResponse(body: Record<string, unknown>): ExtractResult {
  const rawMeta =
    body.metadata && typeof body.metadata === "object"
      ? (body.metadata as Record<string, unknown>)
      : {};
  return {
    markdown: typeof body.markdown === "string" ? body.markdown : "",
    metadata: extractionMetaFromDict(rawMeta),
    requestId: typeof body.request_id === "string" ? body.request_id : "",
  };
}

// ── Bulk ─────────────────────────────────────────────────────────────────────

/**
 * One entry in a bulk job's `results` list.
 *
 * On success, `markdown` and `metadata` are populated and `error` is null.
 * On a per-URL failure, `markdown`/`metadata` are null and `error` carries
 * an API error code (e.g. `target_timeout`).
 */
export interface BulkItem {
  url: string;
  markdown: string | null;
  metadata: ExtractionMeta | null;
  error: string | null;
  /** True when the item completed successfully (no error + has markdown). */
  readonly ok: boolean;
}

export function bulkItemFromDict(data: Record<string, unknown>): BulkItem {
  const rawMeta = data.metadata;
  const url = typeof data.url === "string" ? data.url : "";
  const markdown = typeof data.markdown === "string" ? data.markdown : null;
  const error = typeof data.error === "string" ? data.error : null;
  const metadata =
    rawMeta && typeof rawMeta === "object"
      ? extractionMetaFromDict(rawMeta as Record<string, unknown>)
      : null;
  // `ok` reads from `this` rather than a captured local so it tracks any
  // post-construction mutation of `error` / `markdown`. Previously the
  // getter closed over the initial values and lied about state if either
  // field was reassigned later.
  return {
    url,
    markdown,
    metadata,
    error,
    get ok(): boolean {
      return this.error === null && this.markdown !== null;
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
export interface CrawlItem {
  url: string;
  depth: number;
  markdown: string | null;
  metadata: ExtractionMeta | null;
  error: string | null;
  /** True when the page completed successfully (no error + has markdown). */
  readonly ok: boolean;
}

export function crawlItemFromDict(data: Record<string, unknown>): CrawlItem {
  const rawMeta = data.metadata;
  const url = typeof data.url === "string" ? data.url : "";
  const depth = typeof data.depth === "number" ? data.depth : 0;
  const markdown = typeof data.markdown === "string" ? data.markdown : null;
  const error = typeof data.error === "string" ? data.error : null;
  const metadata =
    rawMeta && typeof rawMeta === "object"
      ? extractionMetaFromDict(rawMeta as Record<string, unknown>)
      : null;
  // See BulkItem.ok — same `this`-based fix.
  return {
    url,
    depth,
    markdown,
    metadata,
    error,
    get ok(): boolean {
      return this.error === null && this.markdown !== null;
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

// ── Type guards ──────────────────────────────────────────────────────────────

export function isBulkJob(job: BulkJob | CrawlJob): job is BulkJob {
  return job.kind === "bulk";
}

export function isCrawlJob(job: BulkJob | CrawlJob): job is CrawlJob {
  return job.kind === "crawl";
}
