import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  __resetMigrationFetchForTest,
  __setMigrationFetchForTest,
} from "../migration/transport";
import { MoveRefusedError, csr, dump, hello } from "./client";

const C = { baseUrl: "https://old.deplo.test", code: "dmove_abc" };

beforeEach(() => {
  process.env.DEPLO_PUBLIC_URL = "https://new.deplo.test";
});

after(() => __resetMigrationFetchForTest());

function chunked(text: string, size: number): Response {
  const bytes = new TextEncoder().encode(text);
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

test("every call carries the code and names this Deplo", async () => {
  let seen: Headers | null = null;
  let url = "";
  __setMigrationFetchForTest(async (input, init) => {
    url = input;
    seen = new Headers(init?.headers);
    return Response.json({ csrPem: "pem" });
  });
  assert.equal(await csr(C, "srv_1"), "pem");
  assert.equal(url, "https://old.deplo.test/api/deplo-move/csr");
  const h = seen as unknown as Headers;
  assert.equal(h.get("authorization"), "Bearer dmove_abc");
  assert.match(h.get("x-deplo-move-peer") ?? "", /^[0-9a-f]{32}$/);
  assert.equal(h.get("x-deplo-move-peer-url"), "https://new.deplo.test");
});

test("the old Deplo's sentence is passed on as it said it, with its handed-over flag", async () => {
  __setMigrationFetchForTest(async () =>
    Response.json(
      { error: "web already answers to the new Deplo.", handedOver: true },
      { status: 409 },
    ),
  );
  await assert.rejects(
    () => csr(C, "srv_1"),
    (e: unknown) =>
      e instanceof MoveRefusedError &&
      e.message === "web already answers to the new Deplo." &&
      e.status === 409 &&
      e.handedOver,
  );
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
