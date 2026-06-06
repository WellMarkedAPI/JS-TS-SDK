/**
 * Tiny mock-fetch helper.
 *
 * Each test installs a list of route handlers keyed by `METHOD path`. The
 * fake fetch finds the matching handler, advances through any queued
 * responses (so a single route can return different bodies on successive
 * calls — useful for waitForJob polling), and records the call so tests
 * can assert on method/headers/body.
 */
export type Handler =
  | { response: () => Response | Promise<Response> }
  | { responses: Array<() => Response | Promise<Response>> };

export interface CapturedCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export class MockFetch {
  readonly calls: CapturedCall[] = [];
  private readonly routes = new Map<string, Handler>();
  private cursors = new Map<string, number>();

  on(method: string, path: string, response: () => Response | Promise<Response>): void {
    this.routes.set(`${method.toUpperCase()} ${path}`, { response });
  }

  onSequence(
    method: string,
    path: string,
    responses: Array<() => Response | Promise<Response>>,
  ): void {
    this.routes.set(`${method.toUpperCase()} ${path}`, { responses });
    this.cursors.set(`${method.toUpperCase()} ${path}`, 0);
  }

  reset(): void {
    this.calls.length = 0;
    this.routes.clear();
    this.cursors.clear();
  }

  readonly fetch: typeof fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const u = new URL(url);
    const path = u.pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    const headers: Record<string, string> = {};
    if (init?.headers) {
      // Headers can be a Headers instance, a plain object, or an array.
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) {
          headers[k.toLowerCase()] = v;
        }
      } else {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
      }
    }

    let body: unknown = undefined;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    this.calls.push({ method, url, path, headers, body });

    const key = `${method} ${path}`;
    const handler = this.routes.get(key);
    if (!handler) {
      return new Response(JSON.stringify({ error: { code: "no_route", message: `No mock route for ${key}` } }), {
        status: 599,
        headers: { "content-type": "application/json" },
      });
    }
    if ("response" in handler) {
      return handler.response();
    }
    const idx = this.cursors.get(key) ?? 0;
    const responder = handler.responses[Math.min(idx, handler.responses.length - 1)];
    this.cursors.set(key, idx + 1);
    return responder!();
  }) as typeof fetch;
}

export function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(extraHeaders ?? {}) },
  });
}

export function emptyResponse(status: number): Response {
  return new Response("", { status });
}
