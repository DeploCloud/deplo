import { test } from "node:test";
import assert from "node:assert/strict";

import { portFor, effectivePortFor } from "./ports";

const proj = (build: number) => ({ build: { port: build } });

test("portFor reads build.port", () => {
  assert.equal(portFor(proj(3000)), 3000);
});

test("effectivePortFor: override wins over the default", () => {
  assert.equal(effectivePortFor(proj(3000), 8080), 8080);
});

test("effectivePortFor: null/undefined override uses the default", () => {
  assert.equal(effectivePortFor(proj(3000), null), 3000);
  assert.equal(effectivePortFor(proj(3000), undefined), 3000);
});

test("effectivePortFor: override of 0 is honoured only via ??, not coerced away", () => {
  // 0 is not a real port, but the ?? contract (only null/undefined defer) is
  // what keeps falsy-but-set overrides from silently vanishing.
  assert.equal(effectivePortFor(proj(3000), 0), 0);
});
