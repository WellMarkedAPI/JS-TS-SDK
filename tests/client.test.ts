/**
 * Mocked-transport tests for the WellMarked client.
 *
 * Mirrors the Python SDK test suite (sdk/tests/test_client.py) — same
 * fixtures, same regression cases, same coverage of polymorphic
 * getJob/waitForJob, custom headers, and rotate_key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APIConnectionError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
  WellMarked,
  WellMarkedError,
  isCrawlJob,
} from "../src/index.js";
import { MockFetch, emptyResponse, jsonResponse } from "./helpers.js";

const API_KEY = "wm_" + "a".repeat(40);
const BASE_URL = "https://api.wellmarked.io";

let mock: MockFetch;

beforeEach(() => {
  mock = new MockFetch();
});

afterEach(() => {
  mock.reset();
});

// ── Extract ────────────────────────────────────────────────────────────────

describe("extract", () => {
  it("returns markdown + metadata + requestId on success", async () => {
    mock.on("POST", "/extract", () =>
      jsonResponse(200, {
        markdown: "## Hello",
        metadata: {
          title: "Hello",
          author: "Me",
          date: "2026-05-01",
          url: "https://example.com",
          retrieved_at: "2026-05-16T12:34:56+00:00",
        },
        request_id: "11111111-1111-1111-1111-111111111111",
      }),
    );

    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    const result = await wm.extract("https://example.com");

    expect(result.markdown).toBe("## Hello");
    expect(result.metadata.title).toBe("Hello");
    expect(result.metadata.author).toBe("Me");
    expect(result.metadata.retrievedAt).not.toBeNull();
    expect(result.requestId).toBe("11111111-1111-1111-1111-111111111111");
    // Quota info is intentionally NOT on extract results — comes from getUsage.
    expect((result as unknown as { rateLimit?: unknown }).rateLimit).toBeUndefined();
  });

  it("raises RateLimitError with retryAfter on 429", async () => {
    mock.on("POST", "/extract", () =>
      jsonResponse(429, {
        error: {
          code: "rate_limit_exceeded",
          message: "Quota hit.",
          retry_after: 1209600,
        },
      }),
    );

    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    await expect(wm.extract("https://example.com")).rejects.toMatchObject({
      code: "rate_limit_exceeded",
      retryAfter: 1209600,
      statusCode: 429,
      // Monthly-quota 429s don't carry a sub-second hint.
      retryAfterMs: undefined,
    });
    // And it's the right class.
    await expect(wm.extract("https://example.com")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("surfaces Retry-After-Ms on rate_limit_too_fast (per-second cap)", async () => {
    // The per-second rate limit returns a Retry-After-Ms header; the
    // SDK exposes it as RateLimitError.retryAfterMs so callers can
    // sleep precisely instead of rounding up to a whole second.
    mock.on("POST", "/extract", () =>
      jsonResponse(
        429,
        {
          error: {
            code: "rate_limit_too_fast",
            message: "Request rate exceeded.",
            retry_after: 1,
          },
        },
        { "Retry-After": "1", "Retry-After-Ms": "43" },
      ),
    );

    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    await expect(wm.extract("https://example.com")).rejects.toMatchObject({
      code: "rate_limit_too_fast",
      retryAfter: 1,
      retryAfterMs: 43,
      statusCode: 429,
    });
  });

  it("raises AuthenticationError on 401", async () => {
    mock.on("POST", "/extract", () =>
      jsonResponse(401, {
        error: { code: "invalid_api_key", message: "Bad key." },
      }),
    );

    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    await expect(wm.extract("https://example.com")).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("raises UnprocessableEntityError with code for target_timeout", async () => {
    mock.on("POST", "/extract", () =>
      jsonResponse(422, {
        error: { code: "target_timeout", message: "Timed out." },
      }),
    );

    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    let caught: unknown;
    try {
      await wm.extract("https://example.com");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnprocessableEntityError);
    expect((caught as UnprocessableEntityError).code).toBe("target_timeout");
  });

  it("ExtractResult surfaces only the documented attributes", async () => {
    mock.on("POST", "/extract", () =>
      jsonResponse(200, {
        markdown: "x",
        metadata: { url: "https://example.com" },
        request_id: "id",
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    const result = await wm.extract("https://example.com");
    expect(new Set(Object.keys(result))).toEqual(
      new Set(["markdown", "metadata", "requestId"]),
    );
  });
});

// ── Bulk ───────────────────────────────────────────────────────────────────

describe("bulk", () => {
  it("returns a queued job on submit", async () => {
    mock.on("POST", "/bulk", () =>
      jsonResponse(200, {
        job_id: "1c4f9a02-0000-0000-0000-000000000000",
        status: "queued",
        total: 2,
        completed: 0,
        results: [],
      }),
    );

    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    const job = await wm.bulk(["https://a.example", "https://b.example"]);

    expect(job.status).toBe("queued");
    expect(job.total).toBe(2);
    expect(job.done).toBe(false);
  });

  it("rejects free-tier with PermissionDeniedError", async () => {
    mock.on("POST", "/bulk", () =>
      jsonResponse(403, {
        error: { code: "plan_not_supported", message: "Upgrade." },
      }),
    );

    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    await expect(wm.bulk(["https://a.example"])).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects empty URL lists client-side with a clear error", async () => {
    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    await expect(wm.bulk([])).rejects.toThrow(/at least one URL/);
    // No network call should have happened.
    expect(mock.calls.length).toBe(0);
  });
});

// ── Usage ──────────────────────────────────────────────────────────────────

describe("getUsage", () => {
  it("is the source of truth for quota", async () => {
    mock.on("GET", "/usage", () =>
      jsonResponse(200, {
        plan: "pro",
        period: "2026-05",
        used: 1042,
        limit: 10000,
        remaining: 8958,
      }),
    );

    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    const usage = await wm.getUsage();

    expect(usage.plan).toBe("pro");
    expect(usage.period).toBe("2026-05");
    expect(usage.used).toBe(1042);
    expect(usage.limit).toBe(10000);
    expect(usage.remaining).toBe(8958);
  });
});

// ── Key rotation ───────────────────────────────────────────────────────────

describe("rotateKey", () => {
  it("updates the auth header for subsequent requests", async () => {
    const newKey = "wm_" + "b".repeat(40);
    mock.on("POST", "/keys/rotate", () =>
      jsonResponse(200, {
        api_key: newKey,
        rotated_at: "2026-05-13T15:32:00.123456+00:00",
      }),
    );
    mock.on("GET", "/usage", () =>
      jsonResponse(200, {
        plan: "pro",
        period: "2026-05",
        used: 0,
        limit: 10000,
        remaining: 10000,
      }),
    );

    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    const rotated = await wm.rotateKey();
    // Subsequent requests should carry the new bearer token.
    await wm.getUsage();
    const lastCall = mock.calls[mock.calls.length - 1]!;
    expect(lastCall.headers["authorization"]).toBe(`Bearer ${newKey}`);

    expect(rotated.apiKey).toBe(newKey);
    expect(rotated.rotatedAt).not.toBeNull();
  });
});

// ── API key resolution ────────────────────────────────────────────────────

describe("api key resolution", () => {
  it("throws when no key is provided or in env", () => {
    const original = process.env.WELLMARKED_API_KEY;
    delete process.env.WELLMARKED_API_KEY;
    try {
      expect(() => new WellMarked({ fetch: mock.fetch })).toThrow(/No API key/);
    } finally {
      if (original !== undefined) process.env.WELLMARKED_API_KEY = original;
    }
  });

  it("falls back to the WELLMARKED_API_KEY env var", () => {
    const original = process.env.WELLMARKED_API_KEY;
    process.env.WELLMARKED_API_KEY = API_KEY;
    try {
      const wm = new WellMarked({ fetch: mock.fetch });
      expect(wm._getApiKey()).toBe(API_KEY);
    } finally {
      if (original === undefined) delete process.env.WELLMARKED_API_KEY;
      else process.env.WELLMARKED_API_KEY = original;
    }
  });
});

// ── ExtractionMeta surfaces all documented sub-attributes ─────────────────

describe("ExtractionMeta", () => {
  it("preserves every documented field", async () => {
    mock.on("POST", "/extract", () =>
      jsonResponse(200, {
        markdown: "x",
        metadata: {
          url: "https://example.com",
          title: "T",
          author: "A",
          date: "2026-05-01",
          retrieved_at: "2026-05-16T12:34:56+00:00",
        },
        request_id: "id",
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    const result = await wm.extract("https://example.com");
    const meta = result.metadata;
    expect(meta.url).toBe("https://example.com");
    expect(meta.title).toBe("T");
    expect(meta.author).toBe("A");
    expect(meta.date).toBe("2026-05-01");
    expect(meta.retrievedAt).not.toBeNull();
    expect(meta.retrievedAt!.getUTCFullYear()).toBe(2026);
    expect(meta.retrievedAt!.getUTCMonth()).toBe(4); // 0-indexed: May
    expect(meta.retrievedAt!.getUTCDate()).toBe(16);
  });

  it("preserves null title/author/date/retrievedAt", async () => {
    mock.on("POST", "/extract", () =>
      jsonResponse(200, {
        markdown: "x",
        metadata: {
          url: "https://example.com",
          title: null,
          author: null,
          date: null,
        },
        request_id: "id",
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    const result = await wm.extract("https://example.com");
    expect(result.metadata.title).toBeNull();
    expect(result.metadata.author).toBeNull();
    expect(result.metadata.date).toBeNull();
    expect(result.metadata.retrievedAt).toBeNull();
  });
});

// ── 2xx with no JSON body raises a clear error ────────────────────────────

describe("contract violations", () => {
  it("2xx with empty body raises a WellMarkedError", async () => {
    mock.on("POST", "/extract", () => emptyResponse(200));
    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    await expect(wm.extract("https://example.com")).rejects.toThrow(/no JSON body/);
    await expect(wm.extract("https://example.com")).rejects.toBeInstanceOf(WellMarkedError);
  });
});

// ── Transport errors wrap into APIConnectionError ─────────────────────────

describe("transport errors", () => {
  it("wraps fetch failures into APIConnectionError", async () => {
    const failingFetch: typeof fetch = async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    };
    const wm = new WellMarked({ apiKey: API_KEY, fetch: failingFetch });
    await expect(wm.extract("https://example.com")).rejects.toBeInstanceOf(APIConnectionError);
  });
});

// ── Crawl ─────────────────────────────────────────────────────────────────

describe("crawl", () => {
  it("returns a queued CrawlJob", async () => {
    mock.on("POST", "/crawl", () =>
      jsonResponse(200, {
        job_id: "9aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        kind: "crawl",
        status: "queued",
        total: 0,
        completed: 0,
        truncated: false,
        truncated_reason: null,
        results: [],
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    const job = await wm.crawl("https://example.com", { depth: 2 });
    expect(job.kind).toBe("crawl");
    expect(job.status).toBe("queued");
    expect(job.truncated).toBe(false);
    expect(job.truncatedReason).toBeNull();
    expect(job.done).toBe(false);
  });

  it("rejects free-tier crawl with PermissionDeniedError", async () => {
    mock.on("POST", "/crawl", () =>
      jsonResponse(403, {
        error: { code: "plan_not_supported", message: "Upgrade." },
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    await expect(wm.crawl("https://example.com", { depth: 1 })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it("raises UnprocessableEntityError for crawl_depth_exceeded", async () => {
    mock.on("POST", "/crawl", () =>
      jsonResponse(422, {
        error: { code: "crawl_depth_exceeded", message: "Pro caps at 5." },
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    let caught: unknown;
    try {
      await wm.crawl("https://example.com", { depth: 10 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnprocessableEntityError);
    expect((caught as UnprocessableEntityError).code).toBe("crawl_depth_exceeded");
  });

  it("rejects negative depth client-side", async () => {
    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    await expect(wm.crawl("https://example.com", { depth: -1 })).rejects.toThrow(
      /depth must be >= 0/,
    );
    expect(mock.calls.length).toBe(0);
  });
});

// ── Polymorphic getJob / waitForJob ───────────────────────────────────────

describe("polymorphic getJob", () => {
  it("returns BulkJob when kind=bulk (single round-trip)", async () => {
    const jobId = "1c4f9a02-0000-0000-0000-000000000000";
    mock.on("GET", `/bulk/${jobId}`, () =>
      jsonResponse(200, {
        job_id: jobId,
        kind: "bulk",
        status: "done",
        total: 1,
        completed: 1,
        results: [
          {
            url: "https://a.example",
            markdown: "## A",
            metadata: { url: "https://a.example" },
            error: null,
          },
        ],
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    const job = await wm.getJob(jobId);
    expect(job.kind).toBe("bulk");
    expect(job.done).toBe(true);
    expect(mock.calls.length).toBe(1);
  });

  it("redispatches to /crawl when kind=crawl", async () => {
    const jobId = "9aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    mock.on("GET", `/bulk/${jobId}`, () =>
      jsonResponse(200, {
        job_id: jobId,
        kind: "crawl",
        status: "done",
        total: 1,
        completed: 1,
        results: [],
      }),
    );
    mock.on("GET", `/crawl/${jobId}`, () =>
      jsonResponse(200, {
        job_id: jobId,
        kind: "crawl",
        status: "done",
        total: 1,
        completed: 1,
        truncated: true,
        truncated_reason: "page_cap_reached",
        results: [
          {
            url: "https://r.example",
            depth: 0,
            markdown: "## R",
            metadata: { url: "https://r.example" },
            error: null,
          },
        ],
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    const job = await wm.getJob(jobId);
    expect(isCrawlJob(job)).toBe(true);
    if (isCrawlJob(job)) {
      expect(job.truncated).toBe(true);
      expect(job.truncatedReason).toBe("page_cap_reached");
      expect(job.results[0]!.depth).toBe(0);
    }
  });
});

// ── waitForJob polling ───────────────────────────────────────────────────

describe("waitForJob", () => {
  it("polls bulk jobs until done", async () => {
    const jobId = "1c4f9a02-0000-0000-0000-000000000000";
    mock.onSequence("GET", `/bulk/${jobId}`, [
      () =>
        jsonResponse(200, {
          job_id: jobId,
          kind: "bulk",
          status: "processing",
          total: 2,
          completed: 1,
          results: [],
        }),
      () =>
        jsonResponse(200, {
          job_id: jobId,
          kind: "bulk",
          status: "done",
          total: 2,
          completed: 2,
          results: [
            {
              url: "https://a.example",
              markdown: "## A",
              metadata: { url: "https://a.example" },
              error: null,
            },
            {
              url: "https://b.example",
              markdown: null,
              metadata: null,
              error: "target_timeout",
            },
          ],
        }),
    ]);

    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    const job = await wm.waitForJob(jobId, { pollIntervalMs: 0, timeoutMs: 5000 });
    expect(job.done).toBe(true);
    expect(job.completed).toBe(2);
    expect(job.results[0]!.ok).toBe(true);
    expect(job.results[1]!.ok).toBe(false);
    expect(job.results[1]!.error).toBe("target_timeout");
  });

  it("uses the typed endpoint after first call for crawl jobs", async () => {
    const jobId = "9aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    // Discovery via /bulk says crawl.
    mock.on("GET", `/bulk/${jobId}`, () =>
      jsonResponse(200, {
        job_id: jobId,
        kind: "crawl",
        status: "processing",
        total: 2,
        completed: 1,
        results: [],
      }),
    );
    mock.onSequence("GET", `/crawl/${jobId}`, [
      // First /crawl: discovery refetch — still processing.
      () =>
        jsonResponse(200, {
          job_id: jobId,
          kind: "crawl",
          status: "processing",
          total: 2,
          completed: 1,
          truncated: false,
          truncated_reason: null,
          results: [],
        }),
      // Second /crawl: actual poll — done.
      () =>
        jsonResponse(200, {
          job_id: jobId,
          kind: "crawl",
          status: "done",
          total: 2,
          completed: 2,
          truncated: false,
          truncated_reason: null,
          results: [
            {
              url: "https://r.example",
              depth: 0,
              markdown: "## R",
              metadata: { url: "https://r.example" },
              error: null,
            },
          ],
        }),
    ]);

    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    const job = await wm.waitForJob(jobId, { pollIntervalMs: 0, timeoutMs: 5000 });
    expect(isCrawlJob(job)).toBe(true);
    expect(job.done).toBe(true);
    // /bulk called once (discovery), /crawl called twice (discovery + poll).
    const bulkCalls = mock.calls.filter((c) => c.path === `/bulk/${jobId}`).length;
    const crawlCalls = mock.calls.filter((c) => c.path === `/crawl/${jobId}`).length;
    expect(bulkCalls).toBe(1);
    expect(crawlCalls).toBe(2);
  });

  it("throws when the job doesn't finish before timeout", async () => {
    const jobId = "1c4f9a02-0000-0000-0000-000000000000";
    mock.on("GET", `/bulk/${jobId}`, () =>
      jsonResponse(200, {
        job_id: jobId,
        kind: "bulk",
        status: "processing",
        total: 2,
        completed: 0,
        results: [],
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    // Tight timeout — first iteration will check the deadline and bail.
    await expect(
      wm.waitForJob(jobId, { pollIntervalMs: 0, timeoutMs: 1 }),
    ).rejects.toThrow(/did not finish/);
  });
});

// ── Custom headers ───────────────────────────────────────────────────────

describe("custom headers", () => {
  it("passes caller-supplied headers on every request", async () => {
    mock.on("POST", "/extract", () =>
      jsonResponse(200, {
        markdown: "## Hi",
        metadata: { url: "https://example.com" },
        request_id: "44444444-4444-4444-4444-444444444444",
      }),
    );

    const wm = new WellMarked({
      apiKey: API_KEY,
      fetch: mock.fetch,
      headers: { "X-Trace-Id": "abc123", "X-Tenant": "acme" },
    });
    await wm.extract("https://example.com");

    const call = mock.calls[0]!;
    expect(call.headers["x-trace-id"]).toBe("abc123");
    expect(call.headers["x-tenant"]).toBe("acme");
    expect(call.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
  });

  it("silently ignores attempts to override Authorization via headers:", async () => {
    mock.on("POST", "/extract", () =>
      jsonResponse(200, {
        markdown: "## Hi",
        metadata: { url: "https://example.com" },
        request_id: "id",
      }),
    );
    const wm = new WellMarked({
      apiKey: API_KEY,
      fetch: mock.fetch,
      headers: {
        Authorization: "Bearer wm_attacker",
        "X-Custom": "ok",
      },
    });
    await wm.extract("https://example.com");
    const call = mock.calls[0]!;
    expect(call.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(call.headers["x-custom"]).toBe("ok");
  });

  it("setHeader / removeHeader take effect immediately", async () => {
    mock.on("POST", "/extract", () =>
      jsonResponse(200, {
        markdown: "## A",
        metadata: { url: "https://example.com" },
        request_id: "id",
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });

    await wm.extract("https://example.com"); // no custom header yet
    wm.setHeader("X-Run-Id", "run-99");
    await wm.extract("https://example.com"); // carries it
    wm.removeHeader("X-Run-Id");
    await wm.extract("https://example.com"); // gone again

    expect(mock.calls[0]!.headers["x-run-id"]).toBeUndefined();
    expect(mock.calls[1]!.headers["x-run-id"]).toBe("run-99");
    expect(mock.calls[2]!.headers["x-run-id"]).toBeUndefined();
  });
});

// ── Timeouts ─────────────────────────────────────────────────────────────

describe("request timeout", () => {
  it("aborts the fetch after timeoutMs", async () => {
    // A fetch that never resolves until the abort signal fires.
    const slowFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }
      });

    const wm = new WellMarked({ apiKey: API_KEY, fetch: slowFetch, timeoutMs: 50 });
    await expect(wm.extract("https://example.com")).rejects.toBeInstanceOf(
      APIConnectionError,
    );
  });
});

// ── Request body shape ───────────────────────────────────────────────────

describe("request body", () => {
  it("sends url + render_js (snake_case) on extract", async () => {
    mock.on("POST", "/extract", () =>
      jsonResponse(200, {
        markdown: "## Hi",
        metadata: { url: "https://example.com" },
        request_id: "id",
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    await wm.extract("https://example.com", { renderJs: true });
    const call = mock.calls[0]!;
    expect(call.body).toEqual({ url: "https://example.com", render_js: true });
  });

  it("sends url + depth + render_js on crawl", async () => {
    mock.on("POST", "/crawl", () =>
      jsonResponse(200, {
        job_id: "x",
        kind: "crawl",
        status: "queued",
        total: 0,
        completed: 0,
        truncated: false,
        truncated_reason: null,
        results: [],
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY, fetch: mock.fetch });
    await wm.crawl("https://example.com", { depth: 2 });
    const call = mock.calls[0]!;
    expect(call.body).toEqual({
      url: "https://example.com",
      depth: 2,
      render_js: false,
    });
  });
});
