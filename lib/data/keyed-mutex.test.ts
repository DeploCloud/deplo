import { test } from "node:test";
import assert from "node:assert/strict";

import { withKeyedLock, hasPendingLock } from "./keyed-mutex";

/** A controllable async task: resolves only when `release()` is called. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setImmediate(r));

test("same key runs operations one at a time, in submission order", async () => {
  const order: string[] = [];
  const a = deferred();
  const b = deferred();

  const p1 = withKeyedLock("k", async () => {
    order.push("a:start");
    await a.promise;
    order.push("a:end");
  });
  const p2 = withKeyedLock("k", async () => {
    order.push("b:start");
    await b.promise;
    order.push("b:end");
  });

  await tick();
  // b must NOT have started while a holds the lock.
  assert.deepEqual(order, ["a:start"]);

  a.resolve();
  await tick();
  assert.deepEqual(order, ["a:start", "a:end", "b:start"]);

  b.resolve();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
});

test("different keys run concurrently", async () => {
  const order: string[] = [];
  const a = deferred();
  const b = deferred();

  const p1 = withKeyedLock("k1", async () => {
    order.push("k1:start");
    await a.promise;
  });
  const p2 = withKeyedLock("k2", async () => {
    order.push("k2:start");
    await b.promise;
  });

  await tick();
  // Both started despite neither having resolved — they don't block each other.
  assert.deepEqual(order.sort(), ["k1:start", "k2:start"]);

  a.resolve();
  b.resolve();
  await Promise.all([p1, p2]);
});

test("withKeyedLock resolves with the operation's return value", async () => {
  const v = await withKeyedLock("k", async () => 42);
  assert.equal(v, 42);
});

test("a thrown operation rejects its own promise but not the next waiter", async () => {
  const results: string[] = [];

  const p1 = withKeyedLock("k", async () => {
    throw new Error("boom");
  });
  const p2 = withKeyedLock("k", async () => {
    results.push("ran-after-failure");
    return "ok";
  });

  await assert.rejects(p1, /boom/);
  assert.equal(await p2, "ok");
  // The failure of p1 did not prevent p2 from running.
  assert.deepEqual(results, ["ran-after-failure"]);
});

test("the key is dropped from the registry once its chain drains", async () => {
  const d = deferred();
  const p = withKeyedLock("drain-me", async () => {
    await d.promise;
  });
  assert.equal(hasPendingLock("drain-me"), true);

  d.resolve();
  await p;
  await tick(); // let the cleanup .then fire
  assert.equal(hasPendingLock("drain-me"), false);
});

test("a key contended again after draining still serializes", async () => {
  // Run once to completion (drops the key), then contend again — the second round
  // must still serialize, proving cleanup didn't break the lock.
  await withKeyedLock("reuse", async () => {});
  await tick();
  assert.equal(hasPendingLock("reuse"), false);

  const order: string[] = [];
  const a = deferred();
  const p1 = withKeyedLock("reuse", async () => {
    order.push("a:start");
    await a.promise;
    order.push("a:end");
  });
  const p2 = withKeyedLock("reuse", async () => {
    order.push("b");
  });
  await tick();
  assert.deepEqual(order, ["a:start"]); // b is queued behind a
  a.resolve();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["a:start", "a:end", "b"]);
});
