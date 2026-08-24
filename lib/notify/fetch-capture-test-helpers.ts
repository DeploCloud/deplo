/**
 * Capture the outbound HTTP a test causes, without a network.
 *
 * Named `*-test-helpers.ts` so the `lib/**\/*.test.ts` runner glob skips it.
 * Same shape the repo already uses for stubbing `globalThis.fetch`
 * (`lib/agent/release.test.ts`): swap it, hand back a restore closure.
 */

export interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FetchCapture {
  calls: CapturedCall[];
  /** Put the real fetch back. Always call this in `after`. */
  restore: () => void;
}

/**
 * @param respond decides the response per URL — default 200 `{}`. Return a
 * `Response` to simulate a provider refusing.
 */
export function captureFetch(
  respond: (url: string) => Response = () =>
    new Response("{}", { status: 200 }),
): FetchCapture {
  const original = globalThis.fetch;
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // Not JSON — keep the raw string, which is itself worth asserting on.
      }
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
      body,
    });
    return respond(url);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
