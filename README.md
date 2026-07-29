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

Get a key at [wellmarked.io](https://wellmarked.io) — or [self-register](#self-registration) with an email.

## Pricing

|                       | Free      | Pro                  | Growth               | Enterprise    |
|-----------------------|-----------|----------------------|----------------------|---------------|
| **Monthly Price**     | $0        | $29/mo               | $79/mo               | $199/mo       |
| **Included Requests** | 1,000/mo  | 10,000/mo            | 40,000/mo            | 250,000/mo    |
| **Annual Price**      | —         | $299/yr              | $799/yr              | $1,999/yr     |
| **Bulk Requests**     | ✅ (up to 5/request) | ✅ (up to 50/request) | ✅ (up to 200/request) | ✅ (Unlimited) |
| **Search**            | ❌         | ✅                    | ✅                    | ✅             |
| **Crawl**             | ❌         | ✅ (2,000 pages/job)  | ✅ (10,000 pages/job) | ✅ (Unlimited) |
| **`json`/`chunks` formats** | ❌  | ✅                    | ✅                    | ✅             |
| **Overage Rate**      | —         | $0.0035/req          | $0.0020/req          | $0.0012/req   |
| **JS Rendering**      | ❌         | ✅                    | ✅                    | ✅             |
| **Priority Queue**    | Last      | Standard             | High                 | Highest       |

See additional pricing information at [wellmarked.io/#pricing](https://wellmarked.io/#pricing).

## CommonJS

Both ESM and CommonJS are published. The package's `exports` field routes consumers automatically:

```javascript
const { WellMarked } = require("wellmarked");

const wm = new WellMarked({ apiKey: "wm_..." });
const result = await wm.extract("https://example.com/article");
```

## Output formats

`extract`, `search`, `bulk`, and `crawl` all take a `format` option. Exactly one content field is populated per result; the rest stay `null`. `contentOf(result)` returns whichever one came back.

```typescript
import { contentOf } from "wellmarked";

const r = await wm.extract(url, { format: "chunks" });
for (const chunk of r.chunks!) console.log(chunk.startToken, chunk.text.slice(0, 40));

(await wm.extract(url, { format: "json" })).blocks;   // typed heading/paragraph/list/code blocks
(await wm.extract(url, { format: "html" })).html;     // cleaned main-content HTML
(await wm.extract(url, { format: "links" })).links;   // every http(s) link in the content
contentOf(await wm.extract(url));                      // whichever field the format populated
```

| `format`     | Field       | Plan  |
|--------------|-------------|-------|
| `"markdown"` | `.markdown` | All   |
| `"html"`     | `.html`     | All   |
| `"links"`    | `.links`    | All   |
| `"json"`     | `.blocks`   | Pro+  |
| `"chunks"`   | `.chunks`   | Pro+  |

Every extraction result also carries `.metrics` (`contentBytes`, `inputTokens`, `outputTokens`, `tokensSaved`, `reductionPct`) — the token-savings ROI of the extraction, or `null` when the tokenizer is unavailable.

## Search

Search the web and extract every result in one call (Pro plan and above). Costs `1 + results.length` requests. Results come back partial — a slow or blocked page is an error item, never sinks the call.

```typescript
const results = await wm.search("retrieval augmented generation", { numResults: 5 });
for (const hit of results.results) {
  if (hit.ok) {
    console.log(hit.title, "→", hit.markdown!.slice(0, 80));
  } else {
    console.log(`${hit.url} failed: ${hit.error}  (snippet: ${hit.snippet})`);
  }
}
```

`numResults` is capped by your plan server-side — Free 5, Pro 10, Growth 50, Enterprise uncapped (no search exceeds the provider's 200-result ceiling). Asking for more returns `422 search_cap_exceeded` naming your cap. `search` takes the full extraction parameter set — `format` and the [compliance overrides](#compliance-overrides) apply to every result. (It does not take `retry`; its per-result deadline can't absorb one.)

## Bulk extraction

Submit many URLs at once (Free: up to 5; Pro: up to 50; Growth: up to 200; Enterprise: unlimited). The call returns immediately with a `jobId`. Poll with `getJob` or block until done with `waitForJob`.

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

Both resolve a job in a **single request** to `GET /jobs/{id}`, which answers for either kind and requires neither the `bulk` nor the `crawl` scope. Earlier versions polled `/bulk/{id}` first just to read `kind`, then re-fetched `/crawl/{id}` for the crawl-only fields — so a key scoped to `crawl` alone got a `403` and could not poll its own job. Requires an API deployed on or after this endpoint's release.

```typescript
import { isCrawlJob } from "wellmarked";

const job = await wm.waitForJob(someJobId);
if (isCrawlJob(job)) {
  console.log("truncated:", job.truncated, job.truncatedReason);
}
```

Bulk submissions carry an automatically generated `Idempotency-Key` (see [Retries & idempotency](#retries--idempotency)), so an internal retry replays the original job rather than enqueuing a second one.

## Crawl

Crawl a site BFS-style from a root URL — same-site links only, with per-plan depth and page caps (Pro: depth 5, up to 2,000 pages; Growth: depth 10, up to 10,000 pages; Enterprise: unlimited). Like `bulk`, this returns a queued job; poll with `getJob` or block until done with `waitForJob` — the same two methods work on both kinds. Pass `renderJs: true` to fetch each page through Playwright instead of httpx; a single shared browser is launched at the start of the crawl and reused across pages.

```typescript
let job = await wm.crawl("https://docs.example.com", { depth: 2, maxPages: 500 });
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

`maxPages` caps how many pages this crawl may bill — it can only narrow your plan's page cap, never widen it. Each successful page consumes one request from your monthly quota — failed pages (timeouts, robots-disallowed, no-content) are not billed. If you run out of quota mid-crawl the job finishes with `truncated: true`, `truncatedReason: "quota_exhausted"`.

## Retries on timeout

`extract`, `bulk`, and `crawl` take a `retry` option — server-side re-attempts when the *target* URL times out (`target_timeout`), each on a fresh connection. Default `0` (one attempt); no upper bound, though the server stops re-attempting once a job's 6-hour lifetime is spent.

```typescript
await wm.extract("https://slow.example.com", { retry: 2 });   // up to 3 fetch attempts
await wm.bulk(urls, { retry: 5 });                            // async workers absorb the wait
```

On the synchronous `extract` each timed-out attempt takes 20–30s, so aggressive values belong on `bulk`/`crawl`. This is distinct from the client's own transport `maxRetries` (see [Retries & idempotency](#retries--idempotency)).

## Compliance overrides

`extract`, `search`, `bulk`, and `crawl` accept three narrow-only overrides on your key's compliance policy — they can tighten it for a single request but never loosen it:

```typescript
await wm.extract("https://example.com/article", {
  allowDomains: ["example.com"],       // subset of what the key already allows
  denyPatterns: ["*/private/*"],       // added to the key's deny list
  respectRobots: "strict",             // can upgrade to strict, never down to lax
});
```

On `extract` a policy denial throws `PermissionDeniedError` (`domain_not_allowed` / `domain_denied` / `robots_disallowed`); on `bulk`/`crawl` it surfaces as a per-item `error` instead.

## Self-registration

Get a free, extract-only key from an email — no existing key needed. The zero-to-first-call path for an agent that discovered WellMarked programmatically.

```typescript
const account = await WellMarked.register("agent@example.com");
const wm = new WellMarked({ apiKey: account.apiKey });   // Free plan, scopes: ["extract"]
console.log((await wm.extract("https://example.com")).markdown);
```

The key is deliberately weak (Free plan, extract only, no billing). To unlock bulk, crawl, search, or paid quota, a human claims the account on [wellmarked.io](https://wellmarked.io).

## Scoped keys

Mint and manage additional keys programmatically (requires a calling key with the `keys` scope). A key can only grant scopes it holds.

```typescript
const created = await wm.createKey(["extract", "bulk"], { name: "ci-pipeline" });
console.log(created.apiKey);                  // shown once — store it

for (const k of await wm.listKeys()) {         // metadata only, never raw values
  console.log(k.id, k.name, k.scopes, k.revokedAt);
}

await wm.revokeKey(created.id);                 // stops authenticating immediately
```

Scope vocabulary: `extract`, `bulk`, `crawl`, `search`, `keys`.

## Audit log

`getLogs()` returns your own request history, newest first — which key ran each call and how its compliance policy decided.

```typescript
const page = await wm.getLogs({ limit: 50, offset: 0 });
for (const entry of page.logs) {
  console.log(entry.timestamp, entry.statusCode, entry.targetUrl, entry.policyDecision);
}
// if (page.hasMore) ... fetch offset += limit
```

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

See the [Webhooks documentation](https://wellmarked.io/docs#webhooks) for the full signature scheme and header reference.

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

## Retries & idempotency

The client retries requests it knows are safe to replay — connection failures and 5xx, and only for GETs and POSTs carrying an `Idempotency-Key`. `bulk()` and `crawl()` send one automatically and reuse it across the SDK's internal retries, so a connection blip replays the original job rather than enqueuing a second one. `POST /extract` is never retried (the API bills it on arrival).

```typescript
new WellMarked({ apiKey: "wm_...", maxRetries: 2 });   // 3 attempts total; 0 disables
```

Pass your own `idempotencyKey` to `bulk()`/`crawl()` to also survive a process crash or your own catch-and-resubmit — same key + same body replays; same key + a different body throws `idempotency_key_reuse`. Records expire after 6 hours.

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
    // err.code is one of: no_content, target_timeout, target_http_error, ...
    console.log(`Extraction failed (${err.code}): ${err.message}`);
  } else {
    throw err;
  }
}
```

| Error class                | HTTP | Typical `code` values                                                                                |
|----------------------------|------|------------------------------------------------------------------------------------------------------|
| `AuthenticationError`      | 401  | `missing_api_key`, `invalid_api_key`                                                                 |
| `PermissionDeniedError`    | 403  | `account_inactive`, `plan_not_supported`, `insufficient_scope`, `forbidden`, `domain_not_allowed`, `domain_denied`, `robots_disallowed` |
| `NotFoundError`            | 404  | `job_not_found`, `key_not_found`                                                                     |
| `UnprocessableEntityError` | 422  | `no_content`, `target_timeout`, `target_http_error`, `unsafe_url`, `bulk_cap_exceeded`, `crawl_depth_exceeded`, `idempotency_key_reuse` |
| `RateLimitError`           | 429  | `rate_limit_too_fast` *(per-second cap; `retryAfterMs` carries the sub-second back-off)* · `rate_limit_exceeded` *(monthly quota; `retryAfter` in seconds)* · `register_rate_limited` |
| `InternalServerError`      | 5xx  | `service_unavailable` *(retryable)*                                                                  |
| `APIConnectionError`       | —    | DNS / TCP / TLS / timeout failures, raised before any HTTP round-trip                                |

`APIStatusError` is the shared base of every HTTP-status error above; all inherit from `WellMarkedError`.

## Configuration

```typescript
new WellMarked({
  apiKey: "wm_...",                         // or set WELLMARKED_API_KEY
  timeoutMs: 30_000,                        // per attempt, default 30s
  maxRetries: 2,                            // transport retries for safely replayable requests
  headers: { "X-Trace-Id": "..." },         // optional: extra headers on every request
});
```

The client always talks to `https://api.wellmarked.io` using the global `fetch` (Node 18+ or any browser).

## TypeScript

Types are bundled. Every public model and error class is exported. The polymorphic `getJob` / `waitForJob` return `BulkJob | CrawlJob` — use the `kind` discriminator or the `isBulkJob`/`isCrawlJob` type guards to narrow.

```typescript
import type {
  BulkJob,
  CrawlJob,
  ExtractResult,
  ExtractionMeta,
  SearchResults,
  CreatedKey,
  ApiKeyInfo,
  LogsPage,
  RegisteredAccount,
  RotatedKey,
  RotatedWebhookSecret,
  Usage,
  WebhookPayload,
} from "wellmarked";
```

The `contentOf`, `isBulkJob`, and `isCrawlJob` helpers, and the webhook helpers (`verifyWebhook`, `WebhookVerificationError`, `WebhookPayload`, `JobWebhookOptions`), are all exported from the package root.

## For Agents

If you are an agent, feel free to find additional context [here](https://wellmarked.io/llms.txt)!

## License

Copyright © 2026 WellMarked. Released under the [MIT License](LICENSE).

Source: <https://github.com/WellMarkedAPI/JS-TS-SDK>

Use of the hosted API at `api.wellmarked.io` remains subject to the
[Terms of Service](https://wellmarked.io/terms).
