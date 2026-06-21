import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLogLevel } from "./log-level-detect";

test("error: bracket tags, level=, stack frames, exceptions", () => {
  const errors = [
    "[ERROR] connection refused",
    "[error] something",
    "level=error msg=\"boom\"",
    "ERROR: failed to bind port",
    "err: socket closed",
    "Uncaught TypeError: x is not a function",
    "Traceback (most recent call last):",
    "    at Object.<anonymous> (/app/index.js:10:5)",
    "TypeError: cannot read property 'x' of undefined",
    "code: ECONNREFUSED",
    "errno=2",
    "[FATAL] out of memory",
    "panic: runtime error",
  ];
  for (const line of errors) {
    assert.equal(detectLogLevel(line), "error", line);
  }
});

test("warn: warn tags, deprecation, glyphs", () => {
  const warns = [
    "[WARN] disk almost full",
    "[warning] retrying",
    "warn: cache miss",
    "WARNING: this is risky",
    "level=warn msg=slow",
    "config option `foo` is deprecated",
    "deprecation: use bar instead",
    "⚠ low memory",
    "notice: falling back",
  ];
  for (const line of warns) {
    assert.equal(detectLogLevel(line), "warn", line);
  }
});

test("success: startup and completion lines, check marks", () => {
  const successes = [
    "[OK] migration applied",
    "Server listening on :8080",
    "now serving at http://localhost:3000",
    "successfully connected to database",
    "completed deployed in 1.2s",
    "ready in 340ms",
    "compiled successfully",
    "✓ build done",
    "container is running",
    "Running on http://0.0.0.0:5000",
  ];
  for (const line of successes) {
    assert.equal(detectLogLevel(line), "success", line);
  }
});

test('"running" yields success but error still wins (checked first)', () => {
  assert.equal(detectLogLevel("worker is running"), "success");
  // An error line that mentions running must stay error — error block runs first.
  assert.equal(detectLogLevel("[ERROR] failed while running migration"), "error");
  assert.equal(detectLogLevel("error: running out of memory"), "error");
});

test("debug: explicit debug/trace tags only", () => {
  const debugs = [
    "[DEBUG] entering handler",
    "debug: payload size 42",
    "level=debug step=3",
    "[trace] span started",
  ];
  for (const line of debugs) {
    assert.equal(detectLogLevel(line), "debug", line);
  }
});

test("info: the default for ordinary lines", () => {
  const infos = [
    "Starting application…",
    "Loaded 12 routes",
    "GET /healthz",
    "user logged in",
    "",
  ];
  for (const line of infos) {
    assert.equal(detectLogLevel(line), "info", line);
  }
});

test("http status code wins over later words", () => {
  // A 2xx access-log line shouldn't read as error just because the path says so.
  assert.equal(detectLogLevel('GET /errors "statusCode": 200'), "success");
  assert.equal(detectLogLevel('"statusCode":"404"'), "warn");
  assert.equal(detectLogLevel("status=500 upstream timeout"), "error");
  assert.equal(detectLogLevel("POST /login 401"), "warn");
});

test("bare 3-digit counts classify as their status range (accepted tradeoff)", () => {
  // Documented cost of bare-number status matching: a count that lands in a
  // status range takes that range's level. We accept this to colour access logs.
  assert.equal(detectLogLevel("Loaded 200 routes"), "success");
  assert.equal(detectLogLevel("Processed 500 items in batch"), "error");
  // Plain HTTP access logs — the case this tradeoff buys us.
  assert.equal(
    detectLogLevel('127.0.0.1 "GET / HTTP/1.1" 200 1234'),
    "success",
  );
  assert.equal(detectLogLevel('127.0.0.1 "GET /x HTTP/1.1" 500 0'), "error");
});

test("avoids Dokploy's greedy bare-word false positives", () => {
  // These contain error/fail-ish words but aren't failures — must not be error.
  assert.notEqual(detectLogLevel("no failures detected, all good"), "error");
  assert.notEqual(detectLogLevel("error handling middleware registered"), "error");
});
