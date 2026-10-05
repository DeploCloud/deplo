import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  __resetMigrationFetchForTest,
  __setMigrationFetchForTest,
} from "../migration/transport";
import {
  MoveRefusedError,
  dump,
  hello,
  pause,
  upload,
  volume,
  workload,
} from "./client";

const C = { baseUrl: "https://old.deplo.test", code: "dmove_abc" };
const APP = { kind: "app" as const, id: "prj_web" };

beforeEach(() => {
  process.env.DEPLO_PUBLIC_URL = "https://new.deplo.test";
});

after(() => __resetMigrationFetchForTest());

function chunked(text: string | Uint8Array, size: number): Response {
  const bytes =
    typeof text === "string" ? new TextEncoder().encode(text) : text;
  let at = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(at, at + size));
        at += size;
      },
    }),
  );
}

async function lines(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const l of it) out.push(l);
  return out;
}

async function bytes(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const c of it) out.push(c);
  return Buffer.concat(out);
}

test("the dump is read one line per frame, however the bytes are cut", async () => {
  const frames = [
    { kind: "begin", tables: ["teams"] },
    { kind: "rows", table: "teams", rows: [{ name: "Café ünïcode" }] },
    { kind: "end", rows: 1, unreadable: 0 },
  ].map((f) => JSON.stringify(f));
  for (const size of [1, 3, 7, 64]) {
    __setMigrationFetchForTest(async () =>
      chunked(`${frames.join("\r\n")}\n\n`, size),
    );
    assert.deepEqual(await lines(dump(C)), frames);
  }
});

test("a dump that stops before its end frame is a failure, not a short copy", async () => {
  __setMigrationFetchForTest(async () =>
    chunked(`${JSON.stringify({ kind: "begin" })}\n{"kind":"ro`, 5),
  );
  await assert.rejects(() => lines(dump(C)), /cut off before it finished/);
});

test("every call carries the code, names this Deplo and names the workload", async () => {
  let seen: Headers | null = null;
  let url = "";
  let body: unknown = null;
  __setMigrationFetchForTest(async (input, init) => {
    url = input;
    seen = new Headers(init?.headers);
    body = JSON.parse(String(init?.body));
    return Response.json({
      leaseUntil: "2026-01-01T00:00:00Z",
      wasRunning: true,
    });
  });
  assert.equal(
    (await pause(C, { ...APP, extra: 1 } as never)).wasRunning,
    true,
  );
  assert.equal(url, "https://old.deplo.test/api/deplo-move/pause");
  assert.deepEqual(body, APP, "only the reference is sent");
  const h = seen as unknown as Headers;
  assert.equal(h.get("authorization"), "Bearer dmove_abc");
  assert.match(h.get("x-deplo-move-peer") ?? "", /^[0-9a-f]{32}$/);
  assert.equal(h.get("x-deplo-move-peer-url"), "https://new.deplo.test");
});

test("the old Deplo's sentence is passed on as it said it", async () => {
  __setMigrationFetchForTest(async () =>
    Response.json(
      { error: "web is not one of the apps being copied." },
      { status: 409 },
    ),
  );
  await assert.rejects(
    () => workload(C, APP),
    (e: unknown) =>
      e instanceof MoveRefusedError &&
      e.message === "web is not one of the apps being copied." &&
      e.status === 409 &&
      e.code === undefined,
  );
});

test("an answer that is not the workload asked for is not a Deplo", async () => {
  __setMigrationFetchForTest(async () =>
    Response.json({ id: "prj_other", volumes: [], hostPaths: [] }),
  );
  await assert.rejects(() => workload(C, APP), /not as a Deplo/);
});

test("a data step streams the raw bytes once, never retried", async () => {
  const payload = new Uint8Array(1000).map((_, i) => i % 251);
  let calls = 0;
  let body: unknown = null;
  __setMigrationFetchForTest(async (_input, init) => {
    calls += 1;
    body = JSON.parse(String(init?.body));
    return chunked(payload, 97);
  });
  const got = await bytes(volume(C, APP, "deplo-web_data"));
  assert.deepEqual(new Uint8Array(got), payload);
  assert.deepEqual(body, { ...APP, volume: "deplo-web_data" });
  assert.equal(calls, 1);

  calls = 0;
  __setMigrationFetchForTest(async () => {
    calls += 1;
    throw Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNRESET" },
    });
  });
  await assert.rejects(() => bytes(volume(C, APP, "v")));
  assert.equal(calls, 1, "a transient failure is not retried");
});

test("a data step's 404 that says why is the agent's not-found, and 204 is empty", async () => {
  __setMigrationFetchForTest(async () =>
    Response.json({ error: "No such volume." }, { status: 404 }),
  );
  await assert.rejects(
    () => bytes(volume(C, APP, "gone")),
    (e: unknown) => e instanceof MoveRefusedError && e.code === 5,
  );
  __setMigrationFetchForTest(async () => new Response(null, { status: 204 }));
  assert.equal((await bytes(volume(C, APP, "empty"))).length, 0);
});

test("a stream cut mid-way is a failure, and stopping early aborts the request", async () => {
  __setMigrationFetchForTest(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.error(new Error("socket hang up"));
          },
        }),
      ),
  );
  await assert.rejects(() => bytes(volume(C, APP, "v")), /cut off/);

  let signal: AbortSignal | undefined;
  __setMigrationFetchForTest(async (_input, init) => {
    signal = init?.signal ?? undefined;
    return chunked(new Uint8Array(10_000), 10);
  });
  const it = volume(C, APP, "v")[Symbol.asyncIterator]();
  await it.next();
  await it.return?.();
  assert.equal(signal?.aborted, true);
});

test("an upload comes with its filename, and closing it ends the request", async () => {
  let signal: AbortSignal | undefined;
  __setMigrationFetchForTest(async (_input, init) => {
    signal = init?.signal ?? undefined;
    return new Response(new Uint8Array([7, 8, 9]), {
      headers: {
        "x-deplo-move-filename": encodeURIComponent("site été.tar.gz"),
      },
    });
  });
  const sent = await upload(C, APP);
  assert.equal(sent.filename, "site été.tar.gz");
  assert.deepEqual([...(await bytes(sent.chunks))], [7, 8, 9]);
  sent.close();
  assert.equal(signal?.aborted, true);
});

test("an address with no Deplo that can move says so in a sentence", async () => {
  __setMigrationFetchForTest(
    async () => new Response("<html>404</html>", { status: 404 }),
  );
  await assert.rejects(() => hello(C), /Nothing at that address can be moved/);
  __setMigrationFetchForTest(async () => Response.json({ hello: "world" }));
  await assert.rejects(() => hello(C), /not as a Deplo/);
});

test("an untrusted certificate is never answered with plain http", async () => {
  __setMigrationFetchForTest(async () => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: { code: "CERT_HAS_EXPIRED" },
    });
  });
  await assert.rejects(
    () => hello(C),
    (e: Error) =>
      /certificate is not one this machine trusts/.test(e.message) &&
      !/http:\/\//.test(e.message),
  );
});

test("a stop asked for mid-copy cuts the stream", async () => {
  const aborter = new AbortController();
  let signal: AbortSignal | undefined;
  __setMigrationFetchForTest(async (_input, init) => {
    signal = init?.signal ?? undefined;
    // Like a real body: it errors once the request is aborted.
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (signal?.aborted)
            controller.error(new DOMException("aborted", "AbortError"));
          else controller.enqueue(new Uint8Array(10));
        },
      }),
    );
  });
  await assert.rejects(async () => {
    for await (const chunk of volume(C, APP, "v", aborter.signal))
      if (chunk) aborter.abort();
  });
  assert.equal(signal?.aborted, true);
});
