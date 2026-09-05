import { test } from "node:test";
import assert from "node:assert/strict";

import { runWithIdentity } from "./auth/request-context";
import { cache, withRequestCache, withoutRequestCache } from "./request-cache";

function counted() {
  let calls = 0;
  const fn = cache(async (id: string) => {
    calls++;
    return `${id}:${calls}`;
  });
  return { fn, calls: () => calls };
}

test("memoizes per argument inside a request scope", async () => {
  const { fn, calls } = counted();
  await withRequestCache(async () => {
    const [a, b, c] = await Promise.all([fn("x"), fn("x"), fn("y")]);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
  assert.equal(calls(), 2);
});

test("is a pass-through outside a scope (React's own cache is inert here)", async () => {
  const { fn, calls } = counted();
  await fn("x");
  await fn("x");
  assert.equal(calls(), 2);
});

test("a fresh scope starts empty, and withoutRequestCache re-reads", async () => {
  const { fn, calls } = counted();
  await withRequestCache(() => fn("x"));
  await withRequestCache(async () => {
    await fn("x");
    await withoutRequestCache(() => fn("x"));
    await fn("x");
  });
  assert.equal(calls(), 3);
});

test("the identity is part of the key, so a cross-team loop never sees a stale answer", async () => {
  const { fn, calls } = counted();
  await withRequestCache(async () => {
    const a = await runWithIdentity({ userId: "u", teamId: "t1" }, () =>
      fn("x"),
    );
    const b = await runWithIdentity({ userId: "u", teamId: "t2" }, () =>
      fn("x"),
    );
    const c = await runWithIdentity({ userId: "u", teamId: "t1" }, () =>
      fn("x"),
    );
    assert.notEqual(a, b);
    assert.equal(a, c);
  });
  assert.equal(calls(), 2);
});
