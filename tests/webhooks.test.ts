import { describe, expect, it } from "vitest";
import { verifyWebhook, WebhookVerificationError } from "../src/index.js";
import { createHmac, randomBytes } from "node:crypto";

// Recreate the signature the API produces (mirrors api/services/webhooks.py:sign).
function apiSign(
  secret: string,
  deliveryId: string,
  ts: number,
  body: Uint8Array,
): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "hex");
  const prefix = Buffer.from(`${deliveryId}.${ts}.`, "ascii");
  const msg = Buffer.concat([prefix, body]);
  const digest = createHmac("sha256", key).update(msg).digest("base64");
  return `v1,${digest}`;
}

function newSecret(): string {
  return "whsec_" + randomBytes(32).toString("hex");
}

function buildHeaders(deliveryId: string, ts: number, sig: string): Record<string, string> {
  return {
    "X-WellMarked-Delivery-Id": deliveryId,
    "X-WellMarked-Timestamp": String(ts),
    "X-WellMarked-Signature": sig,
  };
}

describe("verifyWebhook", () => {
  const payload = {
    event: "job.completed",
    job_id: "jid",
    kind: "bulk",
    status: "done",
    total: 2,
    completed: 2,
    finished_at: "2026-05-27T12:00:00Z",
    results_url: "https://api.wellmarked.io/bulk/jid",
  };
  const body = new TextEncoder().encode(JSON.stringify(payload));

  it("accepts a fresh, correctly-signed delivery", async () => {
    const secret = newSecret();
    const ts = Math.floor(Date.now() / 1000);
    const sig = apiSign(secret, "d-1", ts, body);
    const out = await verifyWebhook({
      secret,
      headers: buildHeaders("d-1", ts, sig),
      body,
    });
    expect(out.event).toBe("job.completed");
    expect(out.kind).toBe("bulk");
    expect(out.job_id).toBe("jid");
  });

  it("is case-insensitive on header lookup", async () => {
    const secret = newSecret();
    const ts = Math.floor(Date.now() / 1000);
    const sig = apiSign(secret, "d-2", ts, body);
    const out = await verifyWebhook({
      secret,
      headers: {
        "x-wellmarked-delivery-id": "d-2",
        "x-wellmarked-timestamp": String(ts),
        "x-wellmarked-signature": sig,
      },
      body,
    });
    expect(out.event).toBe("job.completed");
  });

  it("accepts a Web Headers instance", async () => {
    const secret = newSecret();
    const ts = Math.floor(Date.now() / 1000);
    const sig = apiSign(secret, "d-3", ts, body);
    const hdrs = new Headers(buildHeaders("d-3", ts, sig));
    const out = await verifyWebhook({ secret, headers: hdrs, body });
    expect(out.event).toBe("job.completed");
  });

  it("rejects a wrong secret", async () => {
    const secret = newSecret();
    const ts = Math.floor(Date.now() / 1000);
    const sig = apiSign(secret, "d-4", ts, body);
    await expect(
      verifyWebhook({
        secret: newSecret(),
        headers: buildHeaders("d-4", ts, sig),
        body,
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("rejects a stale timestamp", async () => {
    const secret = newSecret();
    const ts = Math.floor(Date.now() / 1000) - 1000;
    const sig = apiSign(secret, "d-5", ts, body);
    await expect(
      verifyWebhook({
        secret,
        headers: buildHeaders("d-5", ts, sig),
        body,
      }),
    ).rejects.toThrow(/Stale/);
  });

  it("rejects a tampered body", async () => {
    const secret = newSecret();
    const ts = Math.floor(Date.now() / 1000);
    const sig = apiSign(secret, "d-6", ts, body);
    const tampered = new Uint8Array([...body, 33]); // append '!'
    await expect(
      verifyWebhook({
        secret,
        headers: buildHeaders("d-6", ts, sig),
        body: tampered,
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("rejects missing headers", async () => {
    const secret = newSecret();
    const ts = Math.floor(Date.now() / 1000);
    const sig = apiSign(secret, "d-7", ts, body);
    const incomplete = buildHeaders("d-7", ts, sig);
    delete incomplete["X-WellMarked-Signature"];
    await expect(
      verifyWebhook({ secret, headers: incomplete, body }),
    ).rejects.toThrow(/Missing/);
  });

  it("accepts during a secret-rotation overlap", async () => {
    const secret = newSecret();
    const ts = Math.floor(Date.now() / 1000);
    const realSig = apiSign(secret, "d-8", ts, body);
    // Two bogus + one real, space-separated
    const multi = `v1,${"A".repeat(44)} v1,${"B".repeat(44)} ${realSig}`;
    const out = await verifyWebhook({
      secret,
      headers: buildHeaders("d-8", ts, multi),
      body,
    });
    expect(out.event).toBe("job.completed");
  });

  it("accepts a string body (UTF-8 encoded)", async () => {
    const secret = newSecret();
    const ts = Math.floor(Date.now() / 1000);
    const sig = apiSign(secret, "d-9", ts, body);
    const out = await verifyWebhook({
      secret,
      headers: buildHeaders("d-9", ts, sig),
      body: new TextDecoder().decode(body),
    });
    expect(out.event).toBe("job.completed");
  });
});
