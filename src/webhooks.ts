/**
 * WellMarked webhook signature verification.
 *
 *     import { verifyWebhook, WebhookVerificationError } from "wellmarked";
 *
 *     app.post("/hooks/wm", async (req, res) => {
 *       const rawBody = await readRawBody(req);  // bytes, NOT a parsed JSON object
 *       try {
 *         const payload = await verifyWebhook({
 *           secret: process.env.WELLMARKED_WEBHOOK_SECRET!,
 *           headers: req.headers,
 *           body: rawBody,
 *         });
 *         // payload is the validated job.completed object
 *       } catch (err) {
 *         if (err instanceof WebhookVerificationError) {
 *           return res.status(401).end();
 *         }
 *         throw err;
 *       }
 *     });
 *
 * Use `crypto.subtle` (WebCrypto) under the hood, so this works in
 * Node 18+, browsers, Cloudflare Workers, Deno, and Bun without any
 * runtime-specific imports.
 *
 * The signing scheme:
 *
 *   key      = bytes.fromhex(secret.removePrefix("whsec_"))
 *   message  = `${deliveryId}.${timestamp}.${body}` (body bytes appended raw)
 *   digest   = HMAC-SHA256(key, message)
 *   header   = "v1," + base64(digest)
 *
 * Deliveries older than `maxAgeSec` (default 300s = 5 min) are rejected.
 */

const DEFAULT_MAX_AGE_SEC = 300;
const SECRET_PREFIX = "whsec_";

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/**
 * The validated `job.completed` payload returned by `verifyWebhook`.
 *
 * Fields after the common set are crawl-only (`truncated`,
 * `truncated_reason`) or only present when `webhookIncludeResults`
 * was true (`results`, `results_truncated_for_size`). Use a
 * discriminated check on `kind` before reading them.
 */
export interface WebhookPayload {
  event: "job.completed";
  job_id: string;
  kind: "bulk" | "crawl";
  status: "done";
  total: number;
  completed: number;
  finished_at: string;
  results_url: string;
  truncated?: boolean | null;
  truncated_reason?: string | null;
  results?: unknown[];
  results_truncated_for_size?: boolean;
}

export interface VerifyWebhookOptions {
  /** The signing secret WellMarked supplied (`whsec_<64 hex chars>`). */
  secret: string;
  /**
   * Incoming request headers. Either a `Headers` instance, a Node IncomingHttpHeaders,
   * or a plain object. Lookup is case-insensitive.
   */
  headers: Headers | Record<string, string | string[] | undefined>;
  /**
   * The RAW request body. Must be the exact bytes received — a parsed
   * JSON object will not work. Accept any of: Uint8Array, ArrayBuffer,
   * Buffer (Node), or a string (UTF-8 encoded).
   */
  body: Uint8Array | ArrayBuffer | string;
  /** Reject deliveries older than this. Defaults to 300 (5 min). */
  maxAgeSec?: number;
}

/**
 * Verify a WellMarked webhook delivery. Returns the parsed payload, or
 * throws `WebhookVerificationError`.
 */
export async function verifyWebhook(
  options: VerifyWebhookOptions,
): Promise<WebhookPayload> {
  const { secret, headers, body } = options;
  const maxAgeSec = options.maxAgeSec ?? DEFAULT_MAX_AGE_SEC;

  if (!secret) {
    throw new WebhookVerificationError("Webhook secret not configured.");
  }

  const deliveryId = headerLookup(headers, "x-wellmarked-delivery-id");
  const timestamp = headerLookup(headers, "x-wellmarked-timestamp");
  const signature = headerLookup(headers, "x-wellmarked-signature");
  if (!deliveryId || !timestamp || !signature) {
    throw new WebhookVerificationError("Missing webhook signature headers.");
  }

  const tsInt = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(tsInt)) {
    throw new WebhookVerificationError("Bad X-WellMarked-Timestamp.");
  }
  if (Math.abs(Date.now() / 1000 - tsInt) > maxAgeSec) {
    throw new WebhookVerificationError("Stale webhook delivery.");
  }

  let keyBytes: Uint8Array;
  try {
    keyBytes = hexToBytes(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret);
  } catch {
    throw new WebhookVerificationError("Webhook secret is not valid hex.");
  }

  const bodyBytes = toBytes(body);
  // Concatenate "<id>.<ts>." with the raw body bytes — must not round-trip
  // through a decoded string or non-ASCII bytes would mangle the hash.
  const prefix = new TextEncoder().encode(`${deliveryId}.${timestamp}.`);
  const message = concatBytes(prefix, bodyBytes);

  const cryptoObj = getCrypto();
  // crypto.subtle's TS signature wants BufferSource backed by ArrayBuffer (not
  // SharedArrayBuffer). Our Uint8Arrays are constructed with `new Uint8Array(N)`
  // and `TextEncoder().encode`, both of which are ArrayBuffer-backed at runtime —
  // we cast through `BufferSource` to satisfy strict typings without copying.
  const key = await cryptoObj.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  // The header carries one or more space-separated `v1,<base64>` entries
  // (multiple entries support secret-rotation overlap; mirrors Svix /
  // Stripe). Any one matching is sufficient.
  let matched = false;
  for (const entry of signature.split(/\s+/)) {
    if (!entry || !entry.includes(",")) continue;
    const idx = entry.indexOf(",");
    const version = entry.slice(0, idx);
    const value = entry.slice(idx + 1);
    if (version !== "v1" || !value) continue;
    let sigBytes: Uint8Array;
    try {
      sigBytes = base64ToBytes(value);
    } catch {
      continue;
    }
    // crypto.subtle.verify is constant-time by spec.
    if (
      await cryptoObj.subtle.verify(
        "HMAC",
        key,
        sigBytes as BufferSource,
        message as BufferSource,
      )
    ) {
      matched = true;
      break;
    }
  }
  if (!matched) {
    throw new WebhookVerificationError("Webhook signature mismatch.");
  }

  try {
    return JSON.parse(new TextDecoder().decode(bodyBytes)) as WebhookPayload;
  } catch (e) {
    throw new WebhookVerificationError(`Webhook body is not valid JSON: ${e}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function headerLookup(
  headers: Headers | Record<string, string | string[] | undefined>,
  name: string,
): string {
  const lower = name.toLowerCase();
  // Web standard Headers instance — already case-insensitive.
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(lower) ?? "";
  }
  // Plain object / Node IncomingHttpHeaders.
  const rec = headers as Record<string, string | string[] | undefined>;
  for (const k of Object.keys(rec)) {
    if (k.toLowerCase() === lower) {
      const v = rec[k];
      if (Array.isArray(v)) return v[0] ?? "";
      return v ?? "";
    }
  }
  return "";
}

function getCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new WebhookVerificationError(
      "WebCrypto (globalThis.crypto.subtle) is not available in this " +
        "runtime. Upgrade to Node 18.17+, or run in a browser / Workers / Deno / Bun.",
    );
  }
  return c;
}

function toBytes(input: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof input === "string") return new TextEncoder().encode(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return input;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("hex string has odd length");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error("non-hex character");
    out[i] = b;
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  // atob is available in Node 16+ and every modern runtime.
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
