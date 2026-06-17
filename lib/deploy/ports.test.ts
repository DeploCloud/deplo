import { test } from "node:test";
import assert from "node:assert/strict";

import { portFor, effectivePortFor } from "./ports";

const proj = (build: number, dev?: number | null) => ({
  build: { port: build },
  dev: dev === undefined ? undefined : dev === null ? null : { port: dev },
});

test("portFor: production reads build.port", () => {
  assert.equal(portFor(proj(3000, 5173), "production"), 3000);
});

test("portFor: development reads dev.port", () => {
  assert.equal(portFor(proj(3000, 5173), "development"), 5173);
});

test("portFor: development falls back to build.port when dev unset", () => {
  assert.equal(portFor(proj(3000), "development"), 3000);
  assert.equal(portFor(proj(3000, null), "development"), 3000);
});

test("portFor: development falls back when dev.port is 0 (falsy)", () => {
  // dev.port `0` is not a usable port; the `||` fallback is intentional.
  assert.equal(portFor(proj(3000, 0), "development"), 3000);
});

test("effectivePortFor: override wins over the target default", () => {
  assert.equal(effectivePortFor(proj(3000), "production", 8080), 8080);
  assert.equal(effectivePortFor(proj(3000, 5173), "development", 8080), 8080);
});

test("effectivePortFor: null/undefined override uses the target default", () => {
  assert.equal(effectivePortFor(proj(3000), "production", null), 3000);
  assert.equal(effectivePortFor(proj(3000), "production", undefined), 3000);
  assert.equal(effectivePortFor(proj(3000, 5173), "development", null), 5173);
});

test("effectivePortFor: override of 0 is honoured only via ??, not coerced away", () => {
  // `??` (not `||`) so an explicit override of 0 is passed through; the deploy
  // engine never persists 0, but the accessor must not silently swallow it.
  assert.equal(effectivePortFor(proj(3000), "production", 0), 0);
});
