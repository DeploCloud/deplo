import type { DnsRecord } from "./tunnel-api";

/** An in-memory Cloudflare: the slice of its API the panel's tunnel uses. */
export type FakeCloudflare = {
  zones: { id: string; name: string; accountId: string }[];
  tunnels: Map<
    string,
    {
      accountId: string;
      name: string;
      ingress: unknown;
      status: string;
      connections: number;
    }
  >;
  records: Map<string, DnsRecord & { zoneId: string }>;
  calls: string[];
  /** Fails the next call whose "METHOD path" matches, with this status. */
  failNext: { match: RegExp; status: number; message: string } | null;
  /** The status a tunnel reports once it exists. */
  connectedStatus: string;
};

export function fakeCloudflare(seed: Partial<FakeCloudflare> = {}): {
  cf: FakeCloudflare;
  restore: () => void;
} {
  const cf: FakeCloudflare = {
    zones: [{ id: "zone1", name: "example.com", accountId: "acct1" }],
    tunnels: new Map(),
    records: new Map(),
    calls: [],
    failNext: null,
    connectedStatus: "healthy",
    ...seed,
  };
  let seq = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert(
      url.origin === "https://api.cloudflare.com",
      `unexpected fetch ${url}`,
    );
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/client/v4", "");
    const call = `${method} ${path}${url.search}`;
    cf.calls.push(call);
    if (cf.failNext?.match.test(call)) {
      const { status, message } = cf.failNext;
      cf.failNext = null;
      return json(status, {
        success: false,
        errors: [{ code: 1000, message }],
      });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    let m: RegExpMatchArray | null;

    if (method === "GET" && path === "/zones") {
      const name = url.searchParams.get("name");
      return ok(
        cf.zones
          .filter((z) => z.name === name)
          .map((z) => ({
            id: z.id,
            name: z.name,
            account: { id: z.accountId },
          })),
      );
    }
    if (
      (m = path.match(/^\/accounts\/([^/]+)\/cfd_tunnel$/)) &&
      method === "POST"
    ) {
      const id = `tun-${++seq}`;
      cf.tunnels.set(id, {
        accountId: m[1],
        name: body.name,
        ingress: null,
        status: "inactive",
        connections: 0,
      });
      return ok({ id });
    }
    if ((m = path.match(/^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)(\/.*)?$/))) {
      const t = cf.tunnels.get(m[1]);
      const rest = m[2] ?? "";
      if (!t)
        return json(404, {
          success: false,
          errors: [{ message: "not found" }],
        });
      if (rest === "/configurations" && method === "PUT") {
        t.ingress = body.config.ingress;
        return ok({});
      }
      if (rest === "/token" && method === "GET") return ok(`token-for-${m[1]}`);
      if (rest === "/connections" && method === "DELETE") return ok({});
      if (rest === "" && method === "DELETE") {
        cf.tunnels.delete(m[1]);
        return ok({});
      }
      if (rest === "" && method === "GET") {
        // A connector that was started reports in on the first look.
        return ok({
          id: m[1],
          status: cf.connectedStatus,
          connections: cf.connectedStatus === "healthy" ? [{ id: "c1" }] : [],
        });
      }
    }
    if ((m = path.match(/^\/zones\/([^/]+)\/dns_records$/))) {
      const zoneId = m[1];
      if (method === "GET") {
        const name = url.searchParams.get("name");
        return ok(
          [...cf.records.values()].filter(
            (r) => r.zoneId === zoneId && r.name === name,
          ),
        );
      }
      if (method === "POST") {
        const id = `rec-${++seq}`;
        cf.records.set(id, { ...body, id, zoneId });
        return ok({ id });
      }
    }
    if (
      (m = path.match(/^\/zones\/[^/]+\/dns_records\/([^/]+)$/)) &&
      method === "DELETE"
    ) {
      if (!cf.records.delete(m[1]))
        return json(404, {
          success: false,
          errors: [{ message: "not found" }],
        });
      return ok({ id: m[1] });
    }
    throw new Error(`unexpected Cloudflare call ${call}`);
  }) as typeof fetch;
  return {
    cf,
    restore: () => {
      globalThis.fetch = orig;
    },
  };
}

function ok(result: unknown): Response {
  return json(200, { success: true, errors: [], result });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
