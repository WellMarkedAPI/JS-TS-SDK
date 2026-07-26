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
  contentOf,
  isCrawlJob,
} from "../src/index.js";
import { bulkItemFromDict } from "../src/models.js";
import { MockFetch, emptyResponse, jsonResponse } from "./helpers.js";

const API_KEY = "wm_" + "a".repeat(40);
const BASE_URL = "https://api.wellmarked.io";

let mock: MockFetch;

// The client has no `fetch` option (and no `baseUrl`) — it always uses the
// global fetch against https://api.wellmarked.io. Tests therefore stub the
// GLOBAL, exactly as the runtime resolves it (lazily, at call time).
beforeEach(() => {
  mock = new MockFetch();
  vi.stubGlobal("fetch", mock.fetch);
});

afterEach(() => {
  mock.reset();
  vi.unstubAllGlobals();
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

    const wm = new WellMarked({ apiKey: API_KEY });
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

    const wm = new WellMarked({ apiKey: API_KEY });
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

    const wm = new WellMarked({ apiKey: API_KEY });
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

    const wm = new WellMarked({ apiKey: API_KEY });
    await expect(wm.extract("https://example.com")).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("raises UnprocessableEntityError with code for target_timeout", async () => {
    mock.on("POST", "/extract", () =>
      jsonResponse(422, {
        error: { code: "target_timeout", message: "Timed out." },
      }),
    );

    const wm = new WellMarked({ apiKey: API_KEY });
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
    const wm = new WellMarked({ apiKey: API_KEY });
    const result = await wm.extract("https://example.com");
    expect(new Set(Object.keys(result))).toEqual(
      new Set([
        "markdown",
        "blocks",
        "chunks",
        "html",
        "links",
        "metrics",
        "metadata",
        "requestId",
      ]),
    );
    // The default format still lands in `markdown`, unchanged.
    expect(result.markdown).toBe("x");
    expect(result.blocks).toBeNull();
  });

  it("has no baseUrl escape hatch — a smuggled option is ignored", async () => {
    // WellMarked only serves api.wellmarked.io. There is deliberately no
    // baseUrl (or fetch) option; TypeScript rejects them at compile time, and
    // a caller who force-casts past the types still ends up at the real API.
    mock.on("POST", "/extract", () =>
      jsonResponse(200, {
        markdown: "x",
        metadata: { url: "https://example.com" },
        request_id: "id",
      }),
    );
    const smuggled = { apiKey: API_KEY, baseUrl: "http://localhost:8000" };
    const wm = new WellMarked(smuggled as ConstructorParameters<typeof WellMarked>[0]);
    await wm.extract("https://example.com");
    expect(mock.calls.at(-1)!.url.startsWith(BASE_URL)).toBe(true);
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

    const wm = new WellMarked({ apiKey: API_KEY });
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

    const wm = new WellMarked({ apiKey: API_KEY });
    await expect(wm.bulk(["https://a.example"])).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects empty URL lists client-side with a clear error", async () => {
    const wm = new WellMarked({ apiKey: API_KEY });
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

    const wm = new WellMarked({ apiKey: API_KEY });
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

    const wm = new WellMarked({ apiKey: API_KEY });
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
      expect(() => new WellMarked()).toThrow(/No API key/);
    } finally {
      if (original !== undefined) process.env.WELLMARKED_API_KEY = original;
    }
  });

  it("falls back to the WELLMARKED_API_KEY env var", () => {
    const original = process.env.WELLMARKED_API_KEY;
    process.env.WELLMARKED_API_KEY = API_KEY;
    try {
      const wm = new WellMarked();
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
    const wm = new WellMarked({ apiKey: API_KEY });
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
    const wm = new WellMarked({ apiKey: API_KEY });
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
    const wm = new WellMarked({ apiKey: API_KEY });
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
    vi.stubGlobal("fetch", failingFetch);
    const wm = new WellMarked({ apiKey: API_KEY });
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
    const wm = new WellMarked({ apiKey: API_KEY });
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
    const wm = new WellMarked({ apiKey: API_KEY });
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
    const wm = new WellMarked({ apiKey: API_KEY });
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
    const wm = new WellMarked({ apiKey: API_KEY });
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
    mock.on("GET", `/jobs/${jobId}`, () =>
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
    const wm = new WellMarked({ apiKey: API_KEY });
    const job = await wm.getJob(jobId);
    expect(job.kind).toBe("bulk");
    expect(job.done).toBe(true);
    expect(mock.calls.length).toBe(1);
  });

  it("returns a full CrawlJob when kind=crawl, still in ONE call", async () => {
    // This is the regression that matters. getJob used to hit /bulk/{id} just
    // to read `kind`, then re-fetch /crawl/{id} for truncated + depth — two
    // round trips, and a 403 for any key that held `crawl` but not `bulk`.
    const jobId = "9aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    mock.on("GET", `/jobs/${jobId}`, () =>
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
    const wm = new WellMarked({ apiKey: API_KEY });
    const job = await wm.getJob(jobId);
    expect(isCrawlJob(job)).toBe(true);
    if (isCrawlJob(job)) {
      expect(job.truncated).toBe(true);
      expect(job.truncatedReason).toBe("page_cap_reached");
      expect(job.results[0]!.depth).toBe(0);
    }
    expect(mock.calls.length).toBe(1);
  });

  it("never touches the scope-gated /bulk or /crawl poll routes", async () => {
    // Those two require the `bulk` / `crawl` scope respectively; /jobs/{id}
    // requires neither. If a future edit reintroduces either path here, a
    // narrowly-scoped key starts 403ing on its own job again.
    const jobId = "9aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    mock.on("GET", `/jobs/${jobId}`, () =>
      jsonResponse(200, {
        job_id: jobId,
        kind: "crawl",
        status: "done",
        total: 0,
        completed: 0,
        results: [],
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY });
    await wm.getJob(jobId);
    expect(mock.calls.map((c) => c.path)).toEqual([`/jobs/${jobId}`]);
  });
});

// ── waitForJob polling ───────────────────────────────────────────────────

describe("waitForJob", () => {
  it("polls bulk jobs until done", async () => {
    const jobId = "1c4f9a02-0000-0000-0000-000000000000";
    mock.onSequence("GET", `/jobs/${jobId}`, [
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

    const wm = new WellMarked({ apiKey: API_KEY });
    const job = await wm.waitForJob(jobId, { pollIntervalMs: 0, timeoutMs: 5000 });
    expect(job.done).toBe(true);
    expect(job.completed).toBe(2);
    expect(job.results[0]!.ok).toBe(true);
    expect(job.results[1]!.ok).toBe(false);
    expect(job.results[1]!.error).toBe("target_timeout");
  });

  it("polls crawl jobs on /jobs with no dispatch round-trip", async () => {
    const jobId = "9aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    mock.onSequence("GET", `/jobs/${jobId}`, [
      // First call — still processing.
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
      // Second call — done.
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

    const wm = new WellMarked({ apiKey: API_KEY });
    const job = await wm.waitForJob(jobId, { pollIntervalMs: 0, timeoutMs: 5000 });
    expect(isCrawlJob(job)).toBe(true);
    expect(job.done).toBe(true);
    // Two polls, two calls — the old path spent three for the same result
    // (one /bulk discovery + a /crawl refetch + the real poll).
    expect(mock.calls.map((c) => c.path)).toEqual([
      `/jobs/${jobId}`,
      `/jobs/${jobId}`,
    ]);
  });

  it("throws when the job doesn't finish before timeout", async () => {
    const jobId = "1c4f9a02-0000-0000-0000-000000000000";
    mock.on("GET", `/jobs/${jobId}`, () =>
      jsonResponse(200, {
        job_id: jobId,
        kind: "bulk",
        status: "processing",
        total: 2,
        completed: 0,
        results: [],
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY });
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
    const wm = new WellMarked({ apiKey: API_KEY });

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

    vi.stubGlobal("fetch", slowFetch);
    const wm = new WellMarked({ apiKey: API_KEY, timeoutMs: 50 });
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
    const wm = new WellMarked({ apiKey: API_KEY });
    await wm.extract("https://example.com", { renderJs: true });
    const call = mock.calls[0]!;
    expect(call.body).toEqual({
      url: "https://example.com",
      render_js: true,
      format: "markdown",
      retry: 0,
    });
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
    const wm = new WellMarked({ apiKey: API_KEY });
    await wm.crawl("https://example.com", { depth: 2 });
    const call = mock.calls[0]!;
    expect(call.body).toEqual({
      url: "https://example.com",
      depth: 2,
      render_js: false,
      format: "markdown",
      retry: 0,
    });
  });

  it("forwards retry on extract/bulk/crawl and maxPages on crawl", async () => {
    // retry = server-side re-attempts on target_timeout. Search deliberately
    // has no retry option (15s per-hit deadline), so its body must never
    // carry one — pinned by the exact-body search test above.
    mock.on("POST", "/extract", () =>
      jsonResponse(200, {
        markdown: "## Hi",
        metadata: { url: "https://example.com" },
        request_id: "id",
      }),
    );
    mock.on("POST", "/bulk", () =>
      jsonResponse(200, {
        job_id: "x", status: "queued", total: 1, completed: 0, results: [],
      }),
    );
    mock.on("POST", "/crawl", () =>
      jsonResponse(200, {
        job_id: "x", kind: "crawl", status: "queued",
        total: 0, completed: 0, truncated: false,
        truncated_reason: null, results: [],
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY });
    await wm.extract("https://example.com", { retry: 3 });
    await wm.bulk(["https://example.com"], { retry: 2 });
    await wm.crawl("https://example.com", { retry: 1, maxPages: 50 });

    expect(mock.calls[0]!.body).toMatchObject({ retry: 3 });
    expect(mock.calls[1]!.body).toMatchObject({ retry: 2 });
    expect(mock.calls[2]!.body).toMatchObject({ retry: 1, max_pages: 50 });
  });

  it("omits max_pages when maxPages is unset so the plan cap stands", async () => {
    mock.on("POST", "/crawl", () =>
      jsonResponse(200, {
        job_id: "x", kind: "crawl", status: "queued",
        total: 0, completed: 0, truncated: false,
        truncated_reason: null, results: [],
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY });
    await wm.crawl("https://example.com");
    expect(mock.calls[0]!.body).not.toHaveProperty("max_pages");
  });
});

// ── Idempotency-Key ────────────────────────────────────────────────────────
// The header is what makes a retried /bulk replay the original job instead of
// double-charging the caller's quota. If the SDK silently stops sending it,
// the API's protection is inert and nothing else would catch it.

const QUEUED_JOB = {
  job_id: "1c4f9a02-0000-0000-0000-000000000000",
  status: "queued",
  total: 1,
  completed: 0,
  results: [],
};

describe("idempotency", () => {
  it("bulk() sends a generated Idempotency-Key when none is given", async () => {
    mock.on("POST", "/bulk", () => jsonResponse(200, QUEUED_JOB));
    const wm = new WellMarked({ apiKey: API_KEY });

    await wm.bulk(["https://a.example"]);

    expect(mock.calls[0]!.headers["idempotency-key"]).toBeTruthy();
  });

  it("bulk() honours an explicit key", async () => {
    mock.on("POST", "/bulk", () => jsonResponse(200, QUEUED_JOB));
    const wm = new WellMarked({ apiKey: API_KEY });

    await wm.bulk(["https://a.example"], { idempotencyKey: "caller-chosen" });

    expect(mock.calls[0]!.headers["idempotency-key"]).toBe("caller-chosen");
  });

  it("gives each submission a distinct generated key", async () => {
    // Two submissions are two operations — sharing a key would make the
    // second replay the first one's job.
    mock.on("POST", "/bulk", () => jsonResponse(200, QUEUED_JOB));
    const wm = new WellMarked({ apiKey: API_KEY });

    await wm.bulk(["https://a.example"]);
    await wm.bulk(["https://b.example"]);

    expect(mock.calls[0]!.headers["idempotency-key"]).not.toBe(
      mock.calls[1]!.headers["idempotency-key"],
    );
  });

  it("crawl() sends an Idempotency-Key", async () => {
    mock.on("POST", "/crawl", () =>
      jsonResponse(200, { ...QUEUED_JOB, kind: "crawl", total: 0 }),
    );
    const wm = new WellMarked({ apiKey: API_KEY });

    await wm.crawl("https://a.example");

    expect(mock.calls[0]!.headers["idempotency-key"]).toBeTruthy();
  });

  it("a client-wide header cannot pin Idempotency-Key across submissions", async () => {
    // setHeader is client-wide, so it's the wrong channel for idempotency.
    // The per-request key must win, or every later bulk() would replay the
    // first job.
    mock.on("POST", "/bulk", () => jsonResponse(200, QUEUED_JOB));
    const wm = new WellMarked({ apiKey: API_KEY });
    wm.setHeader("Idempotency-Key", "pinned-forever");

    await wm.bulk(["https://a.example"]);
    await wm.bulk(["https://b.example"]);

    expect(mock.calls[0]!.headers["idempotency-key"]).not.toBe("pinned-forever");
    expect(mock.calls[0]!.headers["idempotency-key"]).not.toBe(
      mock.calls[1]!.headers["idempotency-key"],
    );
  });

  it("per-request headers still cannot override Authorization", async () => {
    mock.on("POST", "/bulk", () => jsonResponse(200, QUEUED_JOB));
    const wm = new WellMarked({ apiKey: API_KEY });

    await wm.bulk(["https://a.example"], { idempotencyKey: "k1" });

    expect(mock.calls[0]!.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
  });
});

// ── Internal retry ─────────────────────────────────────────────────────────
// Retries exist so the auto-generated Idempotency-Key is worth something: a
// connection blip is ambiguous (the job may already exist), and replaying with
// the SAME key collapses the attempts into one job instead of two.

describe("retry", () => {
  it("retries a connection failure on bulk and reuses the same key", async () => {
    let attempts = 0;
    const seenKeys: string[] = [];
    const failingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      attempts++;
      const h = init!.headers as Record<string, string>;
      seenKeys.push(h["Idempotency-Key"]!);
      if (attempts === 1) throw new TypeError("network down");
      return jsonResponse(200, QUEUED_JOB);
    }) as typeof fetch;

    vi.stubGlobal("fetch", failingFetch);
    const wm = new WellMarked({ apiKey: API_KEY });
    const job = await wm.bulk(["https://a.example"]);

    expect(attempts).toBe(2);
    expect(job.status).toBe("queued");
    // The whole point: both attempts carry the SAME key, so the API replays
    // rather than creating a second job.
    expect(seenKeys[0]).toBe(seenKeys[1]);
  });

  it("does NOT retry POST /extract — the API bills it on arrival", async () => {
    // A connection error can't tell us whether the extraction happened.
    // /extract takes no Idempotency-Key, so replaying could bill twice.
    let attempts = 0;
    const failingFetch = (async () => {
      attempts++;
      throw new TypeError("network down");
    }) as typeof fetch;

    vi.stubGlobal("fetch", failingFetch);
    const wm = new WellMarked({ apiKey: API_KEY });
    await expect(wm.extract("https://a.example")).rejects.toBeInstanceOf(APIConnectionError);
    expect(attempts).toBe(1);
  });

  it("retries 5xx but not 4xx", async () => {
    let attempts = 0;
    const flaky = (async () => {
      attempts++;
      if (attempts === 1) return jsonResponse(503, { error: { code: "x", message: "down" } });
      return jsonResponse(200, QUEUED_JOB);
    }) as typeof fetch;
    vi.stubGlobal("fetch", flaky);
    const wm = new WellMarked({ apiKey: API_KEY });
    await wm.bulk(["https://a.example"]);
    expect(attempts).toBe(2);

    let attempts4xx = 0;
    const deterministic = (async () => {
      attempts4xx++;
      return jsonResponse(422, {
        error: { code: "bulk_cap_exceeded", message: "too many" },
      });
    }) as typeof fetch;
    vi.stubGlobal("fetch", deterministic);
    const wm2 = new WellMarked({ apiKey: API_KEY });
    await expect(wm2.bulk(["https://a.example"])).rejects.toBeInstanceOf(
      UnprocessableEntityError,
    );
    // 4xx is deterministic — replaying just reproduces it.
    expect(attempts4xx).toBe(1);
  });

  it("gives up after maxRetries and surfaces the connection error", async () => {
    let attempts = 0;
    const alwaysDown = (async () => {
      attempts++;
      throw new TypeError("network down");
    }) as typeof fetch;

    vi.stubGlobal("fetch", alwaysDown);
    const wm = new WellMarked({ apiKey: API_KEY, maxRetries: 1 });
    await expect(wm.bulk(["https://a.example"])).rejects.toBeInstanceOf(APIConnectionError);
    expect(attempts).toBe(2);
  });

  it("maxRetries: 0 disables retrying entirely", async () => {
    let attempts = 0;
    const alwaysDown = (async () => {
      attempts++;
      throw new TypeError("network down");
    }) as typeof fetch;

    vi.stubGlobal("fetch", alwaysDown);
    const wm = new WellMarked({ apiKey: API_KEY, maxRetries: 0 });
    await expect(wm.bulk(["https://a.example"])).rejects.toBeInstanceOf(APIConnectionError);
    expect(attempts).toBe(1);
  });

  it("a client-wide Idempotency-Key must NOT make /extract retryable", async () => {
    // Regression: safeToReplay once read the MERGED headers. Idempotency-Key
    // isn't reserved, so setHeader() could smuggle one onto every request —
    // making POST /extract look replay-safe. The API bills /extract on
    // arrival and ignores the header, so retrying it double-charges.
    let attempts = 0;
    const failingFetch = (async () => {
      attempts++;
      throw new TypeError("network down");
    }) as typeof fetch;

    vi.stubGlobal("fetch", failingFetch);
    const wm = new WellMarked({ apiKey: API_KEY });
    wm.setHeader("Idempotency-Key", "smuggled");

    await expect(wm.extract("https://a.example")).rejects.toBeInstanceOf(APIConnectionError);
    expect(attempts).toBe(1);
  });

  it("a constructor-level Idempotency-Key must NOT make /extract retryable", async () => {
    let attempts = 0;
    const failingFetch = (async () => {
      attempts++;
      throw new TypeError("network down");
    }) as typeof fetch;

    vi.stubGlobal("fetch", failingFetch);
    const wm = new WellMarked({
      apiKey: API_KEY,
      headers: { "Idempotency-Key": "smuggled" },
    });

    await expect(wm.extract("https://a.example")).rejects.toBeInstanceOf(APIConnectionError);
    expect(attempts).toBe(1);
  });
});

// ── Phase 5 continuity: policy overrides, key CRUD, logs ─────────────────────

describe("policy overrides", () => {
  it("sends allow_domains / deny_patterns / respect_robots on extract", async () => {
    mock.on("POST", "/extract", () =>
      jsonResponse(200, {
        markdown: "# ok",
        metadata: { url: "https://a.example" },
        request_id: "r1",
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY });
    await wm.extract("https://a.example", {
      allowDomains: ["a.example"],
      denyPatterns: ["*/admin/*"],
      respectRobots: "strict",
    });
    const sent = mock.calls.at(-1)!.body as Record<string, unknown>;
    expect(sent.allow_domains).toEqual(["a.example"]);
    expect(sent.deny_patterns).toEqual(["*/admin/*"]);
    expect(sent.respect_robots).toBe("strict");
  });

  it("omits policy fields left unset (never clobbers the key's policy)", async () => {
    mock.on("POST", "/extract", () =>
      jsonResponse(200, {
        markdown: "# ok",
        metadata: { url: "https://a.example" },
        request_id: "r1",
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY });
    await wm.extract("https://a.example");
    const sent = mock.calls.at(-1)!.body as Record<string, unknown>;
    expect("allow_domains" in sent).toBe(false);
    expect("deny_patterns" in sent).toBe(false);
    expect("respect_robots" in sent).toBe(false);
  });

  it("surfaces a policy denial on extract as PermissionDeniedError", async () => {
    mock.on("POST", "/extract", () =>
      jsonResponse(403, {
        error: { code: "domain_denied", message: "denied", retry: false },
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY });
    await expect(wm.extract("https://blocked.example")).rejects.toMatchObject({
      code: "domain_denied",
    });
    await expect(wm.extract("https://blocked.example")).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });
});

describe("key management", () => {
  it("createKey posts scopes + name and returns the raw key once", async () => {
    mock.on("POST", "/keys", () =>
      jsonResponse(200, {
        id: "k1",
        api_key: "wm_" + "b".repeat(40),
        name: "ci",
        scopes: ["extract"],
        created_at: "2026-07-17T00:00:00Z",
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY });
    const key = await wm.createKey(["extract"], { name: "ci" });
    expect(key.apiKey.startsWith("wm_")).toBe(true);
    expect(key.scopes).toEqual(["extract"]);
    expect(mock.calls.at(-1)!.body).toEqual({ scopes: ["extract"], name: "ci" });
  });

  it("listKeys returns metadata with an active flag", async () => {
    mock.on("GET", "/keys", () =>
      jsonResponse(200, {
        keys: [
          { id: "k1", name: "default", scopes: ["*"], created_at: "2026-07-01T00:00:00Z", revoked_at: null },
          { id: "k2", name: "ci", scopes: ["extract"], created_at: "2026-07-02T00:00:00Z", revoked_at: "2026-07-03T00:00:00Z" },
        ],
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY });
    const keys = await wm.listKeys();
    expect(keys.map((k) => k.id)).toEqual(["k1", "k2"]);
    expect(keys[0]!.active).toBe(true);
    expect(keys[1]!.active).toBe(false);
  });

  it("revokeKey issues a DELETE and returns the revocation", async () => {
    mock.on("DELETE", "/keys/k2", () =>
      jsonResponse(200, { id: "k2", revoked_at: "2026-07-03T00:00:00Z" }),
    );
    const wm = new WellMarked({ apiKey: API_KEY });
    const revoked = await wm.revokeKey("k2");
    expect(revoked.id).toBe("k2");
    expect(mock.calls.at(-1)!.method).toBe("DELETE");
  });
});

describe("getLogs", () => {
  it("passes limit/offset and parses policy_decision + key_id", async () => {
    mock.on("GET", "/logs", () =>
      jsonResponse(200, {
        logs: [
          {
            id: "r1",
            timestamp: "2026-07-17T00:00:00Z",
            target_url: "https://a.example",
            status_code: 403,
            duration_ms: 3,
            error_code: "domain_denied",
            render_js: false,
            key_id: "k1",
            policy_decision: "domain_denied",
          },
        ],
        limit: 50,
        offset: 0,
        has_more: true,
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY });
    const page = await wm.getLogs({ limit: 50, offset: 0 });
    expect(page.hasMore).toBe(true);
    expect(page.logs[0]!.policyDecision).toBe("domain_denied");
    expect(page.logs[0]!.keyId).toBe("k1");
    expect(mock.calls.at(-1)!.url).toContain("limit=50");
    expect(mock.calls.at(-1)!.url).toContain("offset=0");
  });
});

// ── Phase 6: self-registration ───────────────────────────────────────────────

describe("register (static)", () => {
  it("posts email with no auth header and returns the account", async () => {
    mock.on("POST", "/register", () =>
      jsonResponse(200, {
        api_key: "wm_" + "d".repeat(40),
        user_id: "u1",
        plan: "free",
        scopes: ["extract"],
      }),
    );
    const account = await WellMarked.register("agent@example.com");
    expect(account.apiKey.startsWith("wm_")).toBe(true);
    expect(account.plan).toBe("free");
    expect(account.scopes).toEqual(["extract"]);
    const sent = mock.calls.at(-1)!;
    expect("authorization" in sent.headers).toBe(false);
    expect(sent.body).toEqual({ email: "agent@example.com" });
  });

  it("throws RateLimitError on register_rate_limited", async () => {
    mock.on("POST", "/register", () =>
      jsonResponse(429, {
        error: { code: "register_rate_limited", message: "slow down", retry: true },
      }),
    );
    await expect(
      WellMarked.register("agent@example.com"),
    ).rejects.toMatchObject({ code: "register_rate_limited" });
  });
});

// ── Search ─────────────────────────────────────────────────────────────────

describe("search", () => {
  const SEARCH_BODY = {
    query: "typescript generics",
    results: [
      { url: "https://a.test/1", status: "ok", title: "A", snippet: "s1", markdown: "# A" },
      { url: "https://b.test/2", status: "error", title: "B", snippet: "s2", error: "target_timeout" },
    ],
    request_id: "33333333-3333-3333-3333-333333333333",
  };

  it("returns parsed results and sends the expected payload", async () => {
    mock.on("POST", "/search", () => jsonResponse(200, SEARCH_BODY));

    const wm = new WellMarked({ apiKey: API_KEY });
    const res = await wm.search("typescript generics", { numResults: 2 });

    // Request shape reached the server unchanged (format defaults to markdown;
    // policy overrides are omitted entirely when unset).
    expect(mock.calls.at(-1)?.body).toEqual({
      query: "typescript generics",
      num_results: 2,
      render_js: false,
      format: "markdown",
    });

    expect(res.query).toBe("typescript generics");
    expect(res.requestId).toBe("33333333-3333-3333-3333-333333333333");
    expect(res.results).toHaveLength(2);
    const ok = res.results[0]!;
    const err = res.results[1]!;
    expect(ok.ok).toBe(true);
    expect(ok.markdown).toBe("# A");
    expect(ok.title).toBe("A");
    // A failed page still carries the provider snippet + a stable error code.
    expect(err.ok).toBe(false);
    expect(err.error).toBe("target_timeout");
    expect(err.snippet).toBe("s2");
  });

  it("defaults num_results to 5 when omitted", async () => {
    mock.on("POST", "/search", () => jsonResponse(200, { ...SEARCH_BODY, results: [] }));
    const wm = new WellMarked({ apiKey: API_KEY });
    await wm.search("q");
    expect((mock.calls.at(-1)?.body as { num_results: number }).num_results).toBe(5);
  });

  it("throws PermissionDeniedError on the Pro+ plan gate", async () => {
    mock.on("POST", "/search", () =>
      jsonResponse(403, { error: { code: "plan_not_supported", message: "Pro+ only." } }),
    );
    const wm = new WellMarked({ apiKey: API_KEY });
    await expect(wm.search("q")).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(wm.search("q")).rejects.toMatchObject({ code: "plan_not_supported" });
  });

  it("carries the full extraction parameter set: format + policy overrides", async () => {
    mock.on("POST", "/search", () =>
      jsonResponse(200, {
        query: "q",
        results: [{
          url: "https://a.test/", status: "ok", snippet: "s",
          chunks: [{ text: "hi", start_token: 0, end_token: 2 }],
        }],
        request_id: "33333333-3333-3333-3333-333333333333",
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY });
    const res = await wm.search("q", {
      format: "chunks",
      allowDomains: ["a.test"],
      respectRobots: "strict",
    });

    const sent = mock.calls.at(-1)?.body as Record<string, unknown>;
    expect(sent.format).toBe("chunks");
    expect(sent.allow_domains).toEqual(["a.test"]);
    expect(sent.respect_robots).toBe("strict");
    expect("deny_patterns" in sent).toBe(false);   // unset overrides omitted

    const item = res.results[0]!;
    expect(item.ok).toBe(true);
    expect(item.markdown).toBeNull();
    expect(item.chunks?.[0]).toEqual({ text: "hi", startToken: 0, endToken: 2 });
    expect(contentOf(item)).toBe(item.chunks);     // format-agnostic accessor
  });
});

// ── Output formats (Phase 4.5) ──────────────────────────────────────────────
// The format param must reach the wire, and each format's payload must land in
// its own field. Content silently arriving as null would look to the caller
// like a successful-but-empty extraction.

describe("output formats", () => {
  it("sends format and parses json blocks + metrics", async () => {
    mock.on("POST", "/extract", () =>
      jsonResponse(200, {
        blocks: [
          { type: "heading", text: "Title", level: 1 },
          { type: "paragraph", text: "Body text.", level: null },
        ],
        metrics: {
          content_bytes: 8000,
          input_tokens: 2000,
          output_tokens: 500,
          tokens_saved: 1500,
          reduction_pct: 75.0,
        },
        metadata: { url: "https://example.com" },
        request_id: "id",
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY });
    const result = await wm.extract("https://example.com", { format: "json" });

    expect((mock.calls[0]!.body as Record<string, unknown>).format).toBe("json");
    expect(result.markdown).toBeNull();
    expect(result.blocks?.map((b) => b.type)).toEqual(["heading", "paragraph"]);
    expect(result.blocks?.[0]!.level).toBe(1);
    expect(result.blocks?.[1]!.level).toBeNull();
    expect(result.metrics?.tokensSaved).toBe(1500);
    expect(result.metrics?.reductionPct).toBe(75.0);
    expect(contentOf(result)).toEqual(result.blocks);
  });

  it("parses chunks with contiguous snake_case offsets", async () => {
    mock.on("POST", "/extract", () =>
      jsonResponse(200, {
        chunks: [
          { text: "first ", start_token: 0, end_token: 500 },
          { text: "second", start_token: 500, end_token: 812 },
        ],
        metadata: { url: "https://example.com" },
        request_id: "id",
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY });
    const result = await wm.extract("https://example.com", { format: "chunks" });

    expect(result.chunks?.map((c) => c.startToken)).toEqual([0, 500]);
    // Contiguity survives the snake_case → camelCase mapping.
    expect(result.chunks?.[0]!.endToken).toBe(result.chunks?.[1]!.startToken);
  });

  it("forwards format on bulk and crawl", async () => {
    mock.on("POST", "/bulk", () =>
      jsonResponse(200, {
        job_id: "j",
        kind: "bulk",
        status: "queued",
        total: 1,
        completed: 0,
        results: [],
      }),
    );
    mock.on("POST", "/crawl", () =>
      jsonResponse(200, {
        job_id: "c",
        kind: "crawl",
        status: "queued",
        total: 0,
        completed: 0,
        truncated: false,
        truncated_reason: null,
        results: [],
      }),
    );
    const wm = new WellMarked({ apiKey: API_KEY });
    await wm.bulk(["https://a.test"], { format: "links" });
    await wm.crawl("https://b.test", { format: "html" });

    expect((mock.calls[0]!.body as Record<string, unknown>).format).toBe("links");
    expect((mock.calls[1]!.body as Record<string, unknown>).format).toBe("html");
  });

  it("marks a non-markdown bulk item as ok", () => {
    // Negative control: keying `ok` on `markdown !== null` (as it did before
    // formats existed) reports every successful links/html/chunks item failed.
    const item = bulkItemFromDict({
      url: "https://a.test",
      links: ["https://a.test/x"],
      error: null,
    });
    expect(item.ok).toBe(true);
    expect(item.markdown).toBeNull();
    expect(contentOf(item)).toEqual(["https://a.test/x"]);

    const failed = bulkItemFromDict({
      url: "https://b.test",
      error: "target_timeout",
    });
    expect(failed.ok).toBe(false);
    expect(contentOf(failed)).toBeNull();
  });
});
