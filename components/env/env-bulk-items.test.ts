import { test } from "node:test";
import assert from "node:assert/strict";

import { copyEnvItems, readableEnvItems } from "@/lib/env-bulk";
import { pendingBulkItem } from "./env-bulk-items";

const ITEM = {
  id: "eek_1",
  key: "SMTP_HOST",
  note: "Mail relay",
  example: "smtp.acme.com",
  seenAt: "2026-11-28T00:00:00.000Z",
};

test("a .env.example name joins the selection: it copies its example and is removed by dismissing it", async () => {
  const item = pendingBulkItem(ITEM);
  assert.equal(item.id, "pending:eek_1");
  assert.equal(item.makeSecret, undefined, "nothing to make Secret yet");
  assert.deepEqual(readableEnvItems([item]), [item]);
  assert.equal(copyEnvItems([item]), '# Mail relay\nSMTP_HOST="smtp.acme.com"');

  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    sent.push(String(init?.body));
    return new Response(
      JSON.stringify({ data: { dismissEnvExampleKey: true } }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    assert.equal((await item.remove!()).ok, true);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(sent[0], /dismissEnvExampleKey/);
  assert.match(sent[0], /"id":"eek_1"/);
});

test("a name with no example copies as an empty value", () => {
  assert.equal(
    copyEnvItems([pendingBulkItem({ ...ITEM, note: null, example: null })]),
    'SMTP_HOST=""',
  );
});
