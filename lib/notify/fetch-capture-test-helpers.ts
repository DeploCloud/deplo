export interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FetchCapture {
  calls: CapturedCall[];
  restore: () => void;
}

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
      } catch {}
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
