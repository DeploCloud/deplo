import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";

import { sleep } from "../supervisor";

test("a finished sleep leaves no abort listener on the loop's signal", async () => {
  const ctl = new AbortController();
  for (let i = 0; i < 20; i++) await sleep(1, ctl.signal);
  assert.equal(getEventListeners(ctl.signal, "abort").length, 0);
});

test("an abort still wakes a sleep at once", async () => {
  const ctl = new AbortController();
  const started = Date.now();
  const p = sleep(60_000, ctl.signal);
  ctl.abort();
  await p;
  assert.ok(Date.now() - started < 1_000);
  assert.equal(getEventListeners(ctl.signal, "abort").length, 0);
});
