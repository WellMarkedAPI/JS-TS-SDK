# wellmarked

[![npm](https://img.shields.io/npm/v/wellmarked.svg)](https://www.npmjs.com/package/wellmarked)
[![types](https://img.shields.io/npm/types/wellmarked.svg)](https://www.npmjs.com/package/wellmarked)

Official JavaScript/TypeScript SDK for the **[WellMarked](https://wellmarked.io)** API — convert any URL to clean Markdown.

```bash
npm install wellmarked
```

Requires Node.js 18+ (uses the built-in `fetch`). Works in any modern runtime with a global `fetch` — Node 18+, Deno, Bun, Cloudflare Workers, Vercel Edge, browsers.

## Quick start

```typescript
import { WellMarked } from "wellmarked";

const wm = new WellMarked({ apiKey: "wm_..." });

const result = await wm.extract("https://example.com/article");
console.log(result.markdown);
console.log(result.metadata.title, "by", result.metadata.author);
console.log("retrieved at", result.metadata.retrievedAt);
```

`result.metadata.retrievedAt` is a `Date` (UTC) recording when WellMarked actually fetched the page — distinct from `result.metadata.date` (the article's published date, often `null`). Useful for cache-freshness checks on the caller's side.

The API key can also be picked up from the `WELLMARKED_API_KEY` environment variable, in which case `new WellMarked()` is enough.

Get a key at [wellmarked.io](https://wellmarked.io).

## Pricing

|                       | Free      | Pro                  | Growth               | Enterprise    |
|-----------------------|-----------|----------------------|----------------------|---------------|
| **Monthly Price**     | $0        | $29/mo               | $79/mo               | $199/mo       |
| **Annual Price**      | —         | $299/yr              | $799/yr              | $1,999/yr     |
| **Included Requests** | 1,000/mo  | 10,000/mo            | 40,000/mo            | 250,000/mo    |
| **Bulk Requests**     | ❌         | ✅ (up to 50/request) | ✅ (up to 200/request) | ✅ (Unlimited) |
| **Crawl**             | ❌         | ✅ (2,000 pages/job)  | ✅ (10,000 pages/job) | ✅ (Unlimited) |
| **Overage Rate**      | —         | $0.0035/req          | $0.0020/req          | $0.0012/req   |
| **JS Rendering**      | ❌         | ✅                    | ✅                    | ✅             |
| **Priority Queue**    | Standard  | High                 | High                 | Highest       |

See additional pricing information at [wellmarked.io/#pricing](https://wellmarked.io/#pricing).

## CommonJS

Both ESM and CommonJS are published. The package's `exports` field routes consumers automatically:

```javascript
const { WellMarked } = require("wellmarked");

const wm = new WellMarked({ apiKey: "wm_..." });
const result = await wm.extract("https://example.com/article");
```

## Bulk extraction

Submit many URLs at once (Pro: up to 50; Growth: up to 200; Enterprise: unlimited). The call returns immediately with a `jobId`. Poll with `getJob` or block until done with `waitForJob`.

```typescript
let job = await wm.bulk([
  "https://example.com/article-1",
  "https://example.com/article-2",
]);
job = await wm.waitForJob(job.jobId);        // resolves when status === "done"

for (const item of job.results) {
  if (item.ok) {
    console.log(item.metadata!.title);
  } else {
    console.log(`${item.url} failed: ${item.error}`);
  }
}
```

`getJob` and `waitForJob` are **polymorphic** — they work for both bulk and crawl `jobId`s. The SDK reads a `kind` discriminator from the API response and returns either a `BulkJob` or a `CrawlJob`. Use the `isCrawlJob(job)` type guard (or check `job.kind === "crawl"`) before reading crawl-specific fields like `job.truncated` or `item.depth`.

```typescript
import { isCrawlJob } from "wellmarked";

const job = await wm.waitForJob(someJobId);
if (isCrawlJob(job)) {
  console.log("truncated:", job.truncated, job.truncatedReason);
}
```

## Crawl

Crawl a site BFS-style from a root URL — same-site links only, with per-plan depth and page caps (Pro: depth 5, up to 2,000 pages; Growth: depth 5, up to 10,000 pages; Enterprise: unlimited). Like `bulk`, this returns a queued job; poll with `getJob` or block until done with `waitForJob` — the same two methods work on both kinds. Pass `renderJs: true` to fetch each page through Playwright instead of httpx; a single shared browser is launched at the start of the crawl and reused across pages.

```typescript
let job = await wm.crawl("https://docs.example.com", { depth: 2 });
job = await wm.waitForJob(job.jobId);        // works for crawl AND bulk jobIds

for (const page of job.results) {
  if (page.ok) {
    console.log(`depth=${page.depth} ${page.metadata!.title}`);
  } else {
    console.log(`${page.url} failed: ${page.error}`);
  }
}

if (job.kind === "crawl" && job.truncated) {
  console.log(`crawl stopped early: ${job.truncatedReason}`);
}
```

Each successful page consumes one request from your monthly quota — failed pages (timeouts, robots-disallowed, no-content) are not billed. If you run out of quota mid-crawl the job finishes with `truncated: true`, `truncatedReason: "quota_exhausted"`.

## Webhooks

Instead of polling `waitForJob`, pass a `webhookUrl` to `bulk()` or `crawl()` and we'll POST a signed notification to that URL the moment the job reaches `status === "done"`.

```typescript
const job = await wm.bulk(
  ["https://example.com/article-1", "https://example.com/article-2"],
  { webhookUrl: "https://yourapp.com/hooks/wm" },
);

// First time you ever submit with a webhookUrl, the response carries
// your signing secret — store it now, you only see it once.
if (job.webhookSigningSecret) {
  await saveSecret(job.webhookSigningSecret);
}
```

`webhookSigningSecret` is populated **only** on the submission that first minted it (one-time visibility, Stripe-style). Subsequent submissions return `null`. Lost it? Call `wm.rotateWebhookSecret()`:

```typescript
const rotated = await wm.rotateWebhookSecret();
console.log("New secret:", rotated.webhookSigningSecret);  // save it
```

Rotation invalidates the previous secret immediately. Deliveries already queued for retry are re-signed with the new secret on their next attempt.

### Receiving + verifying a delivery

The SDK ships a verifier built on WebCrypto — it works in Node 18.17+, Cloudflare Workers, Deno, Bun, and modern browsers without any runtime-specific imports.

```typescript
// Express example
import express from "express";
import { WellMarked, verifyWebhook, WebhookVerificationError } from "wellmarked";

const app = express();
const wm = new WellMarked();
const SECRET = process.env.WELLMARKED_WEBHOOK_SECRET!;

// express.raw keeps the body as Buffer — the verifier needs RAW bytes,
// not a parsed JSON object. express.json() WILL break verification.
app.post("/hooks/wm", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const payload = await verifyWebhook({
      secret: SECRET,
      headers: req.headers,
      body: req.body,                       // Buffer (raw bytes)
    });
    // Default payload is "thin": metadata only + results_url. Fetch
    // results with the same SDK against your normal API key.
    const job = await wm.getJob(payload.job_id);
    for (const item of job.results) {
      /* ... */
    }
    res.status(200).end();
  } catch (err) {
    if (err instanceof WebhookVerificationError) return res.status(401).end();
    throw err;
  }
});
```

For a Cloudflare Worker:

```typescript
export default {
  async fetch(req: Request, env: Env) {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    try {
      const payload = await verifyWebhook({
        secret: env.WELLMARKED_WEBHOOK_SECRET,
        headers: req.headers,            // Headers instance is supported
        body: await req.arrayBuffer(),   // ArrayBuffer or Uint8Array
      });
      // ... do something with payload.job_id
      return new Response(null, { status: 200 });
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        return new Response(null, { status: 401 });
      }
      throw err;
    }
  },
};
```

Pass `webhookIncludeResults: true` on submission to inline the full `results` array (capped at ~5 MB; over the cap the payload silently falls back to the thin shape with `results_truncated_for_size: true`).

### Delivery semantics

* Your endpoint must respond with a 2xx within **10 seconds**.
* Retries on any other outcome (timeout, 4xx, 5xx, DNS): **30s, 5m, 30m, 2h, 12h, 24h** — 7 attempts, ~38 hours, then dead-letter.
* `X-WellMarked-Delivery-Id` is stable across retries — use it as your idempotency key. `X-WellMarked-Timestamp` and `X-WellMarked-Signature` are recomputed every attempt.
* Treat delivery as **at-least-once**.

See the [main README's Webhooks section](https://github.com/WellMarkedAPI/WellMarked#webhooks) for the full signature scheme and header reference.

## Custom headers

Pass extra HTTP headers on every request — useful for correlation IDs, multi-tenant identifiers, or a custom user-agent suffix:

```typescript
const wm = new WellMarked({
  apiKey: "wm_...",
  headers: { "X-Trace-Id": "req-abc-123", "X-Tenant": "acme" },
});
await wm.extract("https://example.com");
```

Headers can also be added or removed at runtime:

```typescript
wm.setHeader("X-Run-Id", "run-99");
await wm.extract(/* ... */);                 // carries X-Run-Id
wm.removeHeader("X-Run-Id");
```

`Authorization`, `Content-Type`, and `Accept` are reserved — the SDK manages them itself, and entries passed in `headers:` for those keys are silently ignored. To rotate the bearer token, use `rotateKey()`.

## Usage & rate limits

`getUsage()` is the source of truth for your current-period quota. The quota state belongs on the account, so call `getUsage()` when you want it:

```typescript
const usage = await wm.getUsage();
console.log(
  `${usage.used} / ${usage.limit} used this period (${usage.plan}) — ${usage.remaining} left`,
);
```

`GET /usage` itself does not count toward your quota.

## Key rotation

```typescript
const rotated = await wm.rotateKey();
console.log("New key:", rotated.apiKey);  // shown once — store it before the program exits
```

After `rotateKey()` the client automatically switches to the new key for subsequent calls; you still need to persist `rotated.apiKey` somewhere durable, because the previous key stops working immediately and there is no recovery flow.

## Errors

Every non-2xx response is translated into a typed error class. Catch the base class to handle anything, or the specific subclass to handle one failure mode:

```typescript
import {
  WellMarked,
  AuthenticationError,
  PermissionDeniedError,
  NotFoundError,
  UnprocessableEntityError,
  RateLimitError,
  APIConnectionError,
} from "wellmarked";

const wm = new WellMarked();
try {
  await wm.extract("https://example.com/paywalled");
} catch (err) {
  if (err instanceof RateLimitError) {
    console.log(`Quota hit. Resets in ${err.retryAfter}s.`);
  } else if (err instanceof UnprocessableEntityError) {
    // err.code is one of: no_content, target_timeout, js_rendering_disabled, ...
    console.log(`Extraction failed (${err.code}): ${err.message}`);
  } else {
    throw err;
  }
}
```

| Error class                | HTTP | Typical `code` values                                                                                |
|----------------------------|------|------------------------------------------------------------------------------------------------------|
| `AuthenticationError`      | 401  | `missing_api_key`, `invalid_api_key`                                                                 |
| `PermissionDeniedError`    | 403  | `account_inactive`, `plan_not_supported`, `forbidden`                                                |
| `NotFoundError`            | 404  | `job_not_found`                                                                                      |
| `UnprocessableEntityError` | 422  | `no_content`, `target_timeout`, `js_rendering_disabled`, `bulk_cap_exceeded`, `crawl_depth_exceeded` |
| `RateLimitError`           | 429  | `rate_limit_too_fast` *(per-second cap; `retryAfterMs` carries the sub-second back-off)* · `rate_limit_exceeded` *(monthly quota; `retryAfter` in seconds)* |
| `InternalServerError`      | 5xx  | —                                                                                                    |
| `APIConnectionError`       | —    | DNS / TCP / TLS / timeout failures, raised before any HTTP round-trip                                |

All inherit from `WellMarkedError`.

## Configuration

```typescript
new WellMarked({
  apiKey: "wm_...",                         // or set WELLMARKED_API_KEY
  baseUrl: "https://api.wellmarked.io",
  timeoutMs: 30_000,                        // per request, default 30s
  fetch: customFetch,                       // optional: bring your own fetch
  headers: { "X-Trace-Id": "..." },         // optional: extra headers on every request
});
```

Passing your own `fetch` is useful for custom proxies, polyfills (e.g. `undici` with a custom dispatcher), or test mocking. Any function with the standard `fetch` signature works.

## TypeScript

Types are bundled. Every public model and error class is exported. The polymorphic `getJob` / `waitForJob` return `BulkJob | CrawlJob` — use the `kind` discriminator or the `isBulkJob`/`isCrawlJob` type guards to narrow.

```typescript
import type {
  BulkJob,
  CrawlJob,
  ExtractResult,
  ExtractionMeta,
  RotatedKey,
  RotatedWebhookSecret,
  Usage,
  WebhookPayload,
} from "wellmarked";
```

Webhook-side types and helpers (`verifyWebhook`, `WebhookVerificationError`, `WebhookPayload`, `JobWebhookOptions`) are all exported from the package root.

## For Agents

If you are an agent, feel free to find additional context [here](https://wellmarked.io/llms.txt)!

## License

Copyright © 2026 WellMarked. Released under the [MIT License](LICENSE).

Source: <https://github.com/WellMarkedAPI/WellMarked/tree/master/js-sdk>

Use of the hosted API at `api.wellmarked.io` remains subject to the
[Terms of Service](https://wellmarked.io/terms).
