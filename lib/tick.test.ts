import { test } from "node:test";
import assert from "node:assert/strict";
import { subscribeToTick, tickNow } from "./tick";

test("one interval feeds every subscriber, and stops with the last one", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  let a = 0;
  let b = 0;
  const offA = subscribeToTick(() => a++);
  const offB = subscribeToTick(() => b++);

  t.mock.timers.tick(1000);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(tickNow(), Date.now());

  offA();
  t.mock.timers.tick(1000);
  assert.equal(a, 1);
  assert.equal(b, 2);

  offB();
  t.mock.timers.tick(5000);
  assert.equal(b, 2);

  // A new subscriber starts the clock again.
  let c = 0;
  const offC = subscribeToTick(() => c++);
  t.mock.timers.tick(1000);
  assert.equal(c, 1);
  offC();
});
